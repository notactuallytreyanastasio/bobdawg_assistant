// The empty page: who is here, and a few ways to begin.

export const SUGGESTIONS: readonly string[] = [
  'Explain how a KV cache speeds up inference',
  'Write a Python script that removes duplicate lines from a file',
  'Compare B-trees and LSM trees for a write-heavy workload',
  'Draft a short, polite note declining a meeting',
];

export type WelcomeProps = {
  readonly ready: boolean;
  readonly onPick: (text: string) => void;
};

export function Welcome({ ready, onPick }: WelcomeProps) {
  return (
    <section className="welcome">
      <span className="mark large" aria-hidden="true" />
      <h2>What are we working on?</h2>
      <p>Running on your own hardware.</p>
      <ul className="suggestions">
        {SUGGESTIONS.map((text) => (
          <li key={text}>
            <button type="button" disabled={!ready} onClick={() => onPick(text)}>
              {text}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
