/**
 * v0.6 — DETERMINISTIC REPLAY (§28), pure. Given the durable facts (already validated and hash-verified by the journal
 * reader) and a pure reducer, reconstruct the derived run state. The same facts always reconstruct the same logical
 * state — replay has no clock, no randomness, no I/O. A checkpoint is an optimization: `reconstruct` starts from a
 * verified checkpoint and replays only the tail; the journal stays authoritative.
 *
 * The reducer and state are generic here so the substrate carries no domain knowledge; the per-workflow reducers
 * (tournament progress, delivery lifecycle, apply transaction) plug in where those flows write their facts.
 */

/** The minimal shape replay needs of a durable fact: its sequence and typed payload. */
export interface ReplayFact {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}

/** A pure fold of one fact into the state. Must be deterministic and side-effect-free. */
export type Reducer<S> = (state: S, fact: ReplayFact) => S;

/**
 * Replays facts in `seq` order onto `initial`. Requires the facts to be contiguous and ordered (the journal reader
 * guarantees this); a gap or disorder is a programming error and throws, never a silent skip.
 */
export function replay<S>(facts: readonly ReplayFact[], reducer: Reducer<S>, initial: S): S {
  let state = initial;
  let expected = facts.length > 0 ? facts[0]!.seq : 0;
  for (const fact of facts) {
    if (fact.seq !== expected) throw new Error(`replay received a non-contiguous fact (expected seq ${expected}, got ${fact.seq})`);
    state = reducer(state, fact);
    expected++;
  }
  return state;
}

export interface Checkpointed<S> {
  /** The journal sequence this snapshot was taken AFTER (0 = before any fact). */
  readonly journalSeq: number;
  readonly state: S;
}

/**
 * Reconstructs state from an optional checkpoint plus the full ordered fact list: replays only the facts AFTER the
 * checkpoint's `journalSeq` onto the checkpoint state. With no checkpoint, replays everything from `initial`. The caller
 * must have already verified the checkpoint binds this journal (see `reconcileCheckpoint` in the platform layer); this
 * function assumes that and only does the deterministic fold.
 */
export function reconstruct<S>(checkpoint: Checkpointed<S> | null, facts: readonly ReplayFact[], reducer: Reducer<S>, initial: S): S {
  if (checkpoint === null) return replay(facts, reducer, initial);
  const tail = facts.filter(fact => fact.seq > checkpoint.journalSeq);
  return replay(tail, reducer, checkpoint.state);
}
