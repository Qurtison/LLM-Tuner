import type { TelemetrySample } from '../../../shared/contracts';

export function chartOptions(compact = false): object {
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        spanGaps: false,
        plugins: { legend: { display: !compact, labels: { color: '#a3a3a3' } } },
        scales: {
            x: { display: !compact, ticks: { color: '#737373', maxTicksLimit: 6 } },
            y: { ticks: { color: '#737373', font: { size: compact ? 8 : 12 } } },
        },
    };
}

export function metricSeries(samples: TelemetrySample[], key: keyof TelemetrySample): (number | null)[] {
    return samples.map(sample => {
        const value = sample[key];
        return typeof value === 'number' ? value : null;
    });
}

export function labelsFromPoints(points: { t: number }[]): string[] {
    return points.map(point => new Date(point.t).toLocaleTimeString());
}
