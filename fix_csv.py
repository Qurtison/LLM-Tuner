import os, sys

csv_file = '../logs/benchmarks.csv'
if not os.path.exists(csv_file):
    sys.exit(0)

with open(csv_file, 'r') as f:
    lines = f.readlines()

new_headers = 'Timestamp,Category,Metric,Model,Quant,Ctx,NGL,RPC,Transport,Prompt Tok/s,Gen Tok/s,Prompt Latency (s),Master GPU Util (%),Master GPU Pwr (W),Master GPU Temp (C),Master CPU Util (%),Master CPU Temp (C),Master VRAM (MB),Master RAM (MB),Worker GPU Util (%),Worker GPU Pwr (W),Worker GPU Temp (C),Worker CPU Temp (C),Worker VRAM (MB),Worker RAM (MB),Net Throughput (MB/s),Gen Tokens,Reasoning Tokens,Wall Time (s),Load Time\n'

new_lines = [new_headers]
for line in lines:
    if line.startswith('Category') or line.startswith('Timestamp'):
        continue
    
    parts = line.strip().split(',')
    if len(parts) == 0 or not parts[0]: continue
    
    if not line.startswith('2026-') and not line.startswith('2025-') and not line.startswith('2024-'):
        # prepend a dummy timestamp
        parts = ['2026-07-01T00:00:00.000Z'] + parts
        
    if len(parts) == 26:
        # Migrate from 26 columns to 30
        parts.insert(14, 'N/A') # Master GPU Temp
        parts.insert(16, 'N/A') # Master CPU Temp
        parts.insert(21, 'N/A') # Worker GPU Temp
        parts.insert(22, 'N/A') # Worker CPU Temp
        
    new_lines.append(','.join(parts) + '\n')

with open(csv_file, 'w') as f:
    f.writelines(new_lines)

print('Fixed CSV!')
