import http.server
import socketserver
import json
import subprocess
import time

PORT = 8081

def get_meminfo_usage():
    """Read /proc/meminfo and return (total_kb, used_kb) where used = Total - Available.
    This is the standard Linux 'true used' figure that always >= any single process's RSS."""
    try:
        with open('/proc/meminfo') as f:
            values = {}
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    key = parts[0].rstrip(':')
                    values[key] = int(parts[1])  # in kB
        total = values.get('MemTotal', 0)
        available = values.get('MemAvailable', 0)
        return total, max(total - available, 0)
    except Exception:
        return 0, 0

def get_net_bytes():
    try:
        with open('/proc/net/dev') as f:
            lines = f.readlines()
        rx, tx = 0, 0
        for line in lines[2:]:
            parts = line.split()
            rx += int(parts[1])
            tx += int(parts[9] if len(parts) > 9 else 0)
        return rx + tx # Total bytes transferred
    except Exception:
        return 0

def _parse_cpu_util_from_stat(cpu_stat_data):
    """Parse /proc/stat cpu line to compute utilization percentage.
    Format: cpu  user nice system idle iowait irq softirq steal guest guest_nice
    Returns utilization as float (0-100)."""
    if not cpu_stat_data:
        return 0.0
    total_util = 0.0
    for line in cpu_stat_data.split('\n'):
        if line.startswith('cpu '):
            parts = line.split()
            if len(parts) < 5:
                continue
            # user, nice, system, idle, iowait, irq, softirq, steal
            fields = [float(x) for x in parts[1:]]
            while len(fields) < 8:
                fields.append(0.0)
            user, nice, system, idle, iowait, irq, softirq, steal = fields[:8]
            total = user + nice + system + idle + iowait + irq + softirq + steal
            busy = total - idle
            if total > 0:
                total_util = (busy / total) * 100.0
            break
    # Average across all CPU lines if multiple exist
    cpu_lines_count = sum(1 for l in cpu_stat_data.split('\n') if l.startswith('cpu'))
    if cpu_lines_count > 1 and cpu_lines_count > 0:
        total_util = total_util  # already an average per-line representation
    return round(total_util, 1)

def _parse_netdev(netdev_data):
    """Parse /proc/net/dev output and return (total_bytes, dict_of_interface_bytes).
    /proc/net/dev format (after header lines):
       iface   RX bytes   TX bytes
       eth0:   1234567    7654321
       usb0:   1111111    2222222
    Returns total RX+TX across all interfaces, and a dict {iface: {'rx': bytes, 'tx': bytes, 'total': bytes}}."""
    if not netdev_data:
        return 0, {}
    total_rx = 0
    total_tx = 0
    iface_bytes = {}
    for line in netdev_data.split('\n'):
        line = line.strip()
        if not line or ':' not in line:
            continue
        parts = line.split(':')
        iface = parts[0].strip()
        values = parts[1].split()
        if len(values) < 10:
            continue
        rx = int(values[0])
        tx = int(values[8])
        total_rx += rx
        total_tx += tx
        iface_bytes[iface] = {'rx': rx, 'tx': tx, 'total': rx + tx}
    return total_rx + total_tx, iface_bytes

def _identify_interface_by_subnet(iface_bytes, subnet_prefix):
    """Heuristic: return the interface whose IP is on the given subnet.
    Since we can't get IPs from /proc/net/dev, we return the first interface
    whose name suggests the connection type.
    Returns (interface_name, bytes_dict) or ('other', bytes_dict)."""
    # Common interface naming conventions:
    #   Thunderbolt: usb0, enx<mac>, enp..., usb-ethernet
    #   Wi-Fi/LAN: eth0, wlan0, wlp...
    # For this dashboard, we identify based on known subnets from the UI transport dropdown.
    if not iface_bytes:
        return None, {}
    # Heuristic: Thunderbolt interfaces often use USB-based networking (usb0)
    # or have names starting with 'enx' (MAC address-based names from udev)
    for iface, data in iface_bytes.items():
        if 'usb' in iface or iface.startswith('enx') or 'ethernet' in iface:
            return iface, data
    # Next check for wired LAN (Ethernet non-USB)
    for iface, data in iface_bytes.items():
        if iface in ('eth0', 'enp1s0', 'enp0s20f0', 'eno1', 'eno2'):
            return iface, data
    # Fallback: return the non-loopback interface with highest traffic
    best = max((k for k in iface_bytes if k != 'lo'),
               key=lambda k: iface_bytes[k]['total'], default=None)
    if best:
        return best, iface_bytes.get(best, {})
    first = next(iter(iface_bytes.items()), None)
    return first[0] if first else None, first[1] if first else {}

class HardwareMonitorHandler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200, "ok")
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b'{}'
        req = json.loads(post_data.decode('utf-8'))
        
        stats = {"master": self.get_stats()}
        worker_ssh = req.get('worker_ssh', '').strip()
        if worker_ssh:
            stats['worker'] = self.get_stats(worker_ssh)
            
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(stats).encode())

    def get_stats(self, ssh_prefix=""):
        meminfo_out = ""  # For SSH remote meminfo data; empty for local (uses /proc/meminfo directly)
        nvidia_smi_error = False  # Tracks whether the primary nvidia-smi query failed

        if ssh_prefix:
            # Combined SSH command to avoid multiple connection overheads
            # Use /proc/stat for reliable CPU utilization (works inside containers)
            # Use /sys/class/thermal/thermal_zone*/temp for CPU temp (multiple zones)
            # Use /proc/net/dev for per-interface network byte counters
            shell_cmd = (
                "nvidia-smi '--query-gpu=name,memory.used,memory.total,power.draw,temperature.gpu,utilization.gpu,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_thermal_slowdown' '--format=csv,noheader,nounits' 2>/dev/null || true; "
                "echo '===APPS==='; "
                "nvidia-smi '--query-compute-apps=used_memory,name' '--format=csv,noheader,nounits' 2>/dev/null || true; "
                "echo '===MEMINFO==='; "
                "cat /proc/meminfo 2>/dev/null || true; "
                "echo '===PS==='; "
                "ps ax -o rss,comm 2>/dev/null || true; "
                "echo '===CPU==='; "
                "top -bn1 2>/dev/null || true; "
                "echo '===CPUSTAT==='; "
                "cat /proc/stat 2>/dev/null || true; "
                "echo '===CPUINFO==='; "
                "cat /proc/cpuinfo 2>/dev/null || true; "
                "echo '===TEMP==='; "
                "for f in /sys/class/thermal/thermal_zone[0-9]*/temp; do cat \"$f\" 2>/dev/null && echo \"($f)\" || true; done; echo '===NETDEV==='; "
                "cat /proc/net/dev 2>/dev/null || true"
            )
            # Initialize variables before the try/except so they're always defined
            cpu_stat_out = ""
            netdev_out = ""
            
            try:
                ssh_cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", ssh_prefix, shell_cmd]
                combined_out = subprocess.check_output(ssh_cmd, stderr=subprocess.DEVNULL, timeout=3).decode('utf-8')
                
                sections = combined_out.split('===')
                gpu_out = sections[0].strip()
                apps_out = ""
                meminfo_out = ""
                ps_out = ""
                cpu_out = ""
                cpu_info = ""
                temp_out = ""
                
                for s in sections[1:]:
                    s = s.strip()
                    if s.startswith('APPS'):
                        apps_out = s[4:].strip()
                    elif s.startswith('MEMINFO'):
                        meminfo_out = s[7:].strip()
                    elif s.startswith('PS'):
                        ps_out = s[2:].strip()
                    elif s.startswith('CPUSTAT'):
                        cpu_stat_out = s[7:].strip()
                    elif s.startswith('CPUINFO'):
                        cpu_info = s[7:].strip()
                    elif s.startswith('CPU'):
                        cpu_out = s[3:].strip()
                    elif s.startswith('TEMP'):
                        temp_out = s[4:].strip()
                    elif s.startswith('NETDEV'):
                        netdev_out = s[6:].strip()
            except Exception:
                # Fail fast and return empty / offline indicators, with error flag
                return {
                    "gpu_name": "Offline", "gpu_throttle": False,
                    "vram_used": 0, "vram_total": 1, "process_vram": 0,
                    "gpu_pwr": 0, "gpu_temp": 0, "gpu_util": 0,
                    "ram_used": 0, "ram_total": 1, "process_ram": 0,
                    "cpu_name": "Offline", "cpu_util": 0.0, "cpu_temp": 0, 
                    "net_bytes": 0,
                    "nvidia_smi_error": True
                }
        else:
            # Local stats (run natively, fast, no network latency)
            gpu_out = ""
            apps_out = ""
            ps_out = ""
            cpu_out = ""
            cpu_info = ""
            temp_out = ""
            
            try:
                gpu_out = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,power.draw,temperature.gpu,utilization.gpu,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_thermal_slowdown", "--format=csv,noheader,nounits"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8').strip()
            except Exception as e:
                nvidia_smi_error = True
            
            try:
                apps_out = subprocess.check_output(["nvidia-smi", "--query-compute-apps=used_memory,name", "--format=csv,noheader,nounits"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8')
            except Exception: pass
            
            try:
                ps_out = subprocess.check_output(["ps", "ax", "-o", "rss,comm"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8')
            except Exception: pass
            
            try:
                cpu_out = subprocess.check_output(["top", "-bn1"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8')
            except Exception: pass
            
            try:
                cpu_info = subprocess.check_output(["cat", "/proc/cpuinfo"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8')
            except Exception: pass
            
            try:
                temp_out = subprocess.check_output(["cat", "/sys/class/thermal/thermal_zone0/temp"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8').strip()
            except Exception: pass

        # Helper to parse /proc/meminfo output (works for both local and SSH-remote data)
        def parse_meminfo(data):
            """Parse /proc/meminfo text and return (total_kb, used_kb)."""
            values = {}
            for line in data.split('\n'):
                parts = line.split()
                if len(parts) >= 2:
                    key = parts[0].rstrip(':')
                    values[key] = int(parts[1])
            total = values.get('MemTotal', 0)
            available = values.get('MemAvailable', 0)
            return total, max(total - available, 0)

        # Use meminfo_out for remote (SSH), fall back to local /proc/meminfo for local
        if meminfo_out:
            mem_total_kb, mem_used_kb = parse_meminfo(meminfo_out)
        else:
            mem_total_kb, mem_used_kb = get_meminfo_usage()

        # PARSING DATA (Same for both local and remote)
        # GPU Metrics
        try:
            if nvidia_smi_error or not gpu_out or gpu_out.strip() == '':
                raise ValueError("nvidia-smi query failed or returned empty")
            parts = gpu_out.split('\n')[0].split(',')
            if len(parts) < 6:
                raise ValueError(f"nvidia-smi returned insufficient columns: {gpu_out!r}")
            gpu_name = parts[0].strip()
            vram_used, vram_total = int(float(parts[1])), int(float(parts[2]))
            gpu_pwr = float(parts[3].strip() if parts[3].strip() != '[Not Supported]' else 0)
            gpu_temp = int(parts[4].strip())
            gpu_util = int(parts[5].strip())
            gpu_throttle = 'Active' in parts[6] or 'Active' in parts[7]
        except Exception as e:
            gpu_name, vram_used, vram_total, gpu_pwr, gpu_temp, gpu_util, gpu_throttle = "Unknown", 0, 1, 0, 0, 0, False

        # Process VRAM Metrics
        process_vram = 0
        try:
            for line in apps_out.split('\n'):
                if 'llama-server' in line or 'llama' in line:
                    parts = line.strip().split(',')
                    if len(parts) >= 2:
                        process_vram += int(float(parts[0]))
        except Exception:
            process_vram = 0

        # RAM Metrics — already computed above from /proc/meminfo (Total - Available)
        # so the figure always >= any single process's RSS, avoiding the inverted /
        # garbage "Sys = used - Llama" display when mmap'd model pages inflate RSS.
        ram_total = mem_total_kb // 1024  # convert kB → MB for UI
        ram_used = mem_used_kb // 1024
        if ram_total == 0:
            ram_total = 1
        if ram_used < 0:
            ram_used = 0

        # Process RAM Metrics — sum of RSS (from `ps`) for llama-server processes.
        # This is correct as-is; RSS includes file-backed mmap pages which is
        # the behavior we want to measure here.
        process_ram = 0
        try:
            for line in ps_out.split('\n'):
                if 'llama-server' in line:
                    parts = line.strip().split()
                    if len(parts) >= 2:
                        process_ram += int(parts[0]) // 1024
        except Exception:
            process_ram = 0

        # CPU Metrics — try top first, fall back to /proc/stat delta
        cpu_util = 0.0
        try:
            cpu_line = [l for l in cpu_out.split('\n') if "Cpu(s)" in l][0]
            idle = float(cpu_line.split(',')[3].split('id')[0].strip())
            cpu_util = 100.0 - idle
        except Exception:
            # Fallback: parse /proc/stat first two samples 0.1s apart
            try:
                cpu_util = _parse_cpu_util_from_stat(cpu_stat_out if ssh_prefix else "")
            except Exception:
                cpu_util = 0.0

        try:
            cpu_name = [l for l in cpu_info.split('\n') if "model name" in l][0].split(':')[1].strip()
        except Exception:
            cpu_name = "Unknown CPU"

        # CPU Temp — parse first valid thermal zone value (ignore filename annotations)
        cpu_temp = 0
        if temp_out:
            for line in temp_out.split('\n'):
                line = line.strip().rstrip('()')
                # Strip the path annotation e.g. "/sys/class/thermal/thermal_zone0/temp(thermal_zone0)"
                try:
                    val = int(line.split()[-1] if ' ' in line else line)
                    if 0 < val < 200000:  # valid thermal value in millidegrees
                        cpu_temp = val // 1000
                        break
                except (ValueError, IndexError):
                    pass

        # Network — parse /proc/net/dev per-interface for remote, or use /proc/net/dev for local
        net_bytes = 0
        net_by_interface = {}
        if ssh_prefix and netdev_out:
            # Parse per-interface bytes for remote worker
            net_bytes, net_by_interface = _parse_netdev(netdev_out)
        elif not ssh_prefix:
            net_bytes = get_net_bytes()

        return {
            "gpu_name": gpu_name, "gpu_throttle": gpu_throttle,
            "vram_used": vram_used, "vram_total": vram_total, "process_vram": process_vram,
            "gpu_pwr": gpu_pwr, "gpu_temp": gpu_temp, "gpu_util": gpu_util,
            "ram_used": ram_used, "ram_total": ram_total, "process_ram": process_ram,
            "cpu_name": cpu_name, "cpu_util": cpu_util, "cpu_temp": cpu_temp, 
            "net_bytes": net_bytes,
            "net_by_interface": net_by_interface,
            "nvidia_smi_error": nvidia_smi_error
        }

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), HardwareMonitorHandler) as httpd:
    httpd.serve_forever()