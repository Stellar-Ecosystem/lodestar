import React from 'react';

/**
 * A single point in a real score history, sourced from indexed contract events.
 * Once the Lodestar agents contract emits events, the backend will index them and
 * pass them here as `scoreHistory`.
 */
export interface ScoreEvent {
  /** Unix timestamp (seconds) of the on-chain event */
  timestamp: number;
  /** Agent score after this event */
  score: number;
}

interface Props {
  currentScore: number;
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  /**
   * Real, indexed score history sourced from contract events.
   * Pass `null` (or omit) while events are not yet available — the chart will
   * fall back to a synthesised approximation and label it as such.
   * Pass an empty array to show the "no history yet" empty state without any line.
   */
  scoreHistory?: ScoreEvent[] | null;
}

const WIDTH = 120;
const HEIGHT = 30;

/** Build a synthetic history by replaying deltas backwards from the current score. */
function buildSyntheticPoints(
  currentScore: number,
  successfulPayments: number,
  failedPayments: number
): number[] {
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

  // Guarantee the last point is the known current score.
  history[history.length - 1] = currentScore;
  return history;
}

function toPolylinePoints(values: number[]): string {
  const stepX = WIDTH / Math.max(1, values.length - 1);
  return values
    .map((val, i) => {
      const x = i * stepX;
      const y = HEIGHT - (val / 1000) * HEIGHT;
      return `${x},${y}`;
    })
    .join(' ');
}

export function ScoreHistoryChart({
  currentScore,
  totalPayments,
  successfulPayments,
  failedPayments,
  scoreHistory = null,
}: Props) {
  // ── Real event data path ────────────────────────────────────────────────────
  if (scoreHistory !== null) {
    if (scoreHistory.length === 0) {
      // Events are available but there are none yet — honest empty state.
      return (
        <div className="flex flex-col items-end">
          <div className="text-[10px] text-secondary mb-1">Score History</div>
          <div
            className="text-[10px] text-secondary italic"
            style={{ width: WIDTH, height: HEIGHT, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            No history yet
          </div>
        </div>
      );
    }

    // Real events — render without any caveats.
    const values = scoreHistory.map((e) => e.score);
    const points = toPolylinePoints(values);
    const lastY = HEIGHT - (values[values.length - 1] / 1000) * HEIGHT;

    return (
      <div className="flex flex-col items-end">
        <div className="text-[10px] text-secondary mb-1">Score History</div>
        <svg
          width={WIDTH}
          height={HEIGHT}
          className="overflow-visible"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          aria-label="Score history chart"
        >
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-primary opacity-80"
            points={points}
          />
          <circle cx={WIDTH} cy={lastY} r="3" className="fill-primary" />
        </svg>
      </div>
    );
  }

  // ── Synthetic data path ─────────────────────────────────────────────────────
  // No real events available. Only render when the agent has made at least one
  // payment, otherwise there is nothing to reconstruct.
  if (successfulPayments === 0 && failedPayments === 0) {
    return null;
  }

  const syntheticValues = buildSyntheticPoints(
    currentScore,
    successfulPayments,
    failedPayments
  );
  const points = toPolylinePoints(syntheticValues);
  const lastY = HEIGHT - (syntheticValues[syntheticValues.length - 1] / 1000) * HEIGHT;

  return (
    <div className="flex flex-col items-end">
      {/* Explicit disclaimer: this is fabricated, not historical */}
      <div
        className="text-[10px] text-secondary mb-1"
        title={
          'Estimated only — the order and shape are reconstructed from payment counts, ' +
          'not from real on-chain events. Exact history will be available once contract events are indexed.'
        }
      >
        Score History (estimated)
      </div>
      <svg
        width={WIDTH}
        height={HEIGHT}
        className="overflow-visible"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        aria-label="Estimated score history chart"
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-primary opacity-40"
          points={points}
        />
        <circle cx={WIDTH} cy={lastY} r="3" className="fill-primary opacity-60" />
      </svg>
    </div>
  );
}
