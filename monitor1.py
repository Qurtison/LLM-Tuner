import http.server
import socketserver
import json
import subprocess

PORT = 8081

class HardwareMonitorHandler(http.server.SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(200, "ok")
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        # Handle the actual telemetry request
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
        cmd_prefix = ["ssh", ssh_prefix] if ssh_prefix else []
        
        # 1. Fetch GPU VRAM (using nvidia-smi)
        try:
            gpu_cmd = cmd_prefix + ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"]
            gpu_out = subprocess.check_output(gpu_cmd, stderr=subprocess.DEVNULL, timeout=2).decode('utf-8').strip()
            # If multiple GPUs, just grab the first one for simplicity
            vram_used, vram_total = map(int, gpu_out.split('\n')[0].split(','))
        except Exception:
            vram_used, vram_total = 0, 1
            
        # 2. Fetch System RAM (using free -m)
        try:
            ram_cmd = cmd_prefix + ["free", "-m"]
            ram_out = subprocess.check_output(ram_cmd, stderr=subprocess.DEVNULL, timeout=2).decode('utf-8')
            mem_line = [l for l in ram_out.split('\n') if l.startswith('Mem:')][0]
            parts = mem_line.split()
            ram_total, ram_used = int(parts[1]), int(parts[2])
        except Exception:
            ram_used, ram_total = 0, 1
            
        return {
            "vram_used": vram_used,
            "vram_total": vram_total,
            "ram_used": ram_used,
            "ram_total": ram_total
        }

print(f"Hardware Telemetry Bridge listening on port {PORT}...")
print("Run this on your 3080 (Master) alongside your llama.cpp server.")
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), HardwareMonitorHandler) as httpd:
    httpd.serve_forever()