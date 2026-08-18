/**
 * Note number to frequency. Lives outside the engines so every engine gets
 * alternate temperaments for free.
 */
export class TuningTable {
  private divisions = 12;
  private refNote = 69;
  private refHz = 440;

  setEqualDivisions(n: number): void {
    this.divisions = n < 1 ? 1 : n;
  }

  setReference(midiNote: number, hz: number): void {
    this.refNote = midiNote;
    this.refHz = hz;
  }

  frequency(midiNote: number): number {
    return this.refHz * Math.pow(2, (midiNote - this.refNote) / this.divisions);
  }
}
