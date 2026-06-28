import React from 'react';

/**
 * Renders a sparkline chart approximating the agent's score history.
 *
 * It reconstructs the history backwards using the known score deltas:
 * +10 for a successful payment, -25 for a failed payment.
 */
export function ScoreHistoryChart({
  currentScore,
  totalPayments,
  successfulPayments,
  failedPayments,
}: {
  currentScore: number;
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
}) {
  if (successfulPayments === 0 && failedPayments === 0) {
    return null;
  }

  const history: number[] = [];
  let score = currentScore - successfulPayments * 10 + failedPayments * 25;
  history.push(Math.max(0, Math.min(1000, score)));

  let s = successfulPayments;
  let f = failedPayments;

  while (s > 0 || f > 0) {
    if (s > 0 && (f === 0 || s >= f)) {
      score += 10;
      s--;
    } else {
      score -= 25;
      f--;
    }
    history.push(Math.max(0, Math.min(1000, score)));
  }

  history[history.length - 1] = currentScore;

  const width = 120;
  const height = 30;

  const stepX = width / Math.max(1, history.length - 1);

  const points = history
    .map((val, i) => {
      const x = i * stepX;
      const y = height - (val / 1000) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div className="flex flex-col items-end">
      <div className="text-[10px] text-secondary mb-1">Score History (approx)</div>
      <svg width={width} height={height} className="overflow-visible" viewBox={`0 0 ${width} ${height}`}>
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-primary opacity-80"
          points={points}
        />
        {history.length > 0 && (
          <circle
            cx={width}
            cy={height - (history[history.length - 1] / 1000) * height}
            r="3"
            className="fill-primary"
          />
        )}
      </svg>
    </div>
  );
}
