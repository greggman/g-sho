/** A point in the drawing, in [0, 1] coordinates (x right, y down). */
export type Point = [x: number, y: number];

/** The points of one stroke, in the order they were drawn. */
export type Stroke = Point[];

export interface Candidate {
  char: string;
  /** probability in [0, 1] */
  score: number;
}

/**
 * Recognizes a handwritten character. Implementations look at the rendered
 * image of the strokes, not their count, order, or direction.
 */
export interface Recognizer {
  /** short name, shown when comparing recognizers */
  readonly name: string;
  /** Candidates for the drawing, best first. */
  recognize(strokes: Stroke[], count: number): Promise<Candidate[]>;
}
