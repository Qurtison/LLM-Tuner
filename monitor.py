import http.server
import socketserver
import json
import subprocess
import time

PORT = 8081

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
        if ssh_prefix:
            # Combined SSH command to avoid multiple connection overheads
            shell_cmd = (
                "nvidia-smi '--query-gpu=name,memory.used,memory.total,power.draw,temperature.gpu,utilization.gpu,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_thermal' '--format=csv,noheader,nounits' 2>/dev/null || true; "
                "echo '===APPS==='; "
                "nvidia-smi '--query-compute-apps=used_memory,name' '--format=csv,noheader,nounits' 2>/dev/null || true; "
                "echo '===RAM==='; "
                "free -m 2>/dev/null || true; "
                "echo '===PS==='; "
                "ps ax -o rss,comm 2>/dev/null || true; "
                "echo '===CPU==='; "
                "top -bn1 2>/dev/null || true; "
                "echo '===CPUINFO==='; "
                "cat /proc/cpuinfo 2>/dev/null || true; "
                "echo '===TEMP==='; "
                "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || true"
            )
            try:
                ssh_cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=1", ssh_prefix, shell_cmd]
                combined_out = subprocess.check_output(ssh_cmd, stderr=subprocess.DEVNULL, timeout=3).decode('utf-8')
                
                sections = combined_out.split('===')
                gpu_out = sections[0].strip()
                apps_out = ""
                ram_out = ""
                ps_out = ""
                cpu_out = ""
                cpu_info = ""
                temp_out = ""
                
                for s in sections[1:]:
                    s = s.strip()
                    if s.startswith('APPS'):
                        apps_out = s[4:].strip()
                    elif s.startswith('RAM'):
                        ram_out = s[3:].strip()
                    elif s.startswith('PS'):
                        ps_out = s[2:].strip()
                    elif s.startswith('CPUINFO'):
                        cpu_info = s[7:].strip()
                    elif s.startswith('CPU'):
                        cpu_out = s[3:].strip()
                    elif s.startswith('TEMP'):
                        temp_out = s[4:].strip()
            except Exception:
                # Fail fast and return empty / offline indicators
                return {
                    "gpu_name": "Offline", "gpu_throttle": False,
                    "vram_used": 0, "vram_total": 1, "process_vram": 0,
                    "gpu_pwr": 0, "gpu_temp": 0, "gpu_util": 0,
                    "ram_used": 0, "ram_total": 1, "process_ram": 0,
                    "cpu_name": "Offline", "cpu_util": 0.0, "cpu_temp": 0, 
                    "net_bytes": 0
                }
        else:
            # Local stats (run natively, fast, no network latency)
            gpu_out = ""
            apps_out = ""
            ram_out = ""
            ps_out = ""
            cpu_out = ""
            cpu_info = ""
            temp_out = ""
            
            try:
                gpu_out = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,power.draw,temperature.gpu,utilization.gpu,clocks_throttle_reasons.hw_slowdown,clocks_throttle_reasons.sw_thermal", "--format=csv,noheader,nounits"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8').strip()
            except Exception: pass
            
            try:
                apps_out = subprocess.check_output(["nvidia-smi", "--query-compute-apps=used_memory,name", "--format=csv,noheader,nounits"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8')
            except Exception: pass
            
            try:
                ram_out = subprocess.check_output(["free", "-m"], stderr=subprocess.DEVNULL, timeout=2).decode('utf-8')
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

        # PARSING DATA (Same for both local and remote)
        # GPU Metrics
        try:
            parts = gpu_out.split('\n')[0].split(',')
            gpu_name = parts[0].strip()
            vram_used, vram_total = int(float(parts[1])), int(float(parts[2]))
            gpu_pwr = float(parts[3].strip() if parts[3].strip() != '[Not Supported]' else 0)
            gpu_temp = int(parts[4].strip())
            gpu_util = int(parts[5].strip())
            gpu_throttle = 'Active' in parts[6] or 'Active' in parts[7]
        except Exception:
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

        # RAM Metrics
        try:
            mem_line = [l for l in ram_out.split('\n') if l.startswith('Mem:')][0]
            ram_total, ram_used = int(mem_line.split()[1]), int(mem_line.split()[2])
        except Exception:
            ram_used, ram_total = 0, 1

        # Process RAM Metrics
        process_ram = 0
        try:
            for line in ps_out.split('\n'):
                if 'llama-server' in line:
                    parts = line.strip().split()
                    if len(parts) >= 2:
                        process_ram += int(parts[0]) // 1024
        except Exception:
            process_ram = 0

        # CPU Metrics
        try:
            cpu_line = [l for l in cpu_out.split('\n') if "Cpu(s)" in l][0]
            idle = float(cpu_line.split(',')[3].split('id')[0].strip())
            cpu_util = 100.0 - idle
        except Exception:
            cpu_util = 0.0

        try:
            cpu_name = [l for l in cpu_info.split('\n') if "model name" in l][0].split(':')[1].strip()
        except Exception:
            cpu_name = "Unknown CPU"

        try:
            cpu_temp = int(temp_out) // 1000
        except Exception:
            cpu_temp = 0

        net_bytes = get_net_bytes() if not ssh_prefix else 0

        return {
            "gpu_name": gpu_name, "gpu_throttle": gpu_throttle,
            "vram_used": vram_used, "vram_total": vram_total, "process_vram": process_vram,
            "gpu_pwr": gpu_pwr, "gpu_temp": gpu_temp, "gpu_util": gpu_util,
            "ram_used": ram_used, "ram_total": ram_total, "process_ram": process_ram,
            "cpu_name": cpu_name, "cpu_util": cpu_util, "cpu_temp": cpu_temp, 
            "net_bytes": net_bytes
        }

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), HardwareMonitorHandler) as httpd:
    httpd.serve_forever()