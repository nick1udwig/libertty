import type { RepairIntent, RepairResult } from './protocol.ts';
import { readingPipeline, readingRequest } from './reading-request.ts';
export type PreparedChoice = RepairResult['choices'][number];

export function repairChoices(
  result: Pick<RepairResult, 'original' | 'candidates'> &
    Partial<Pick<RepairResult, 'actions' | 'choices'>>,
  phrases: string[],
): PreparedChoice[] {
  if (result.choices?.length) return result.choices;
  const texts = result.candidates
    .filter((candidate) => !candidate.literal && candidate.command !== result.original)
    .map((candidate) => candidate.command);
  texts.push(result.original);
  return texts.map((text, index) => {
    const literal = index === texts.length - 1;
    const pipeline = readingPipeline(text, phrases, true);
    const reading = readingRequest(text, phrases, true);
    const action: RepairIntent =
      result.actions?.[text] ||
      (pipeline
        ? { kind: 'reading-pipeline', ...pipeline }
        : reading
          ? { kind: 'reading-file', phrase: reading.phrase, operand: reading.operand }
          : { kind: 'shell' });
    return { id: literal ? 'original' : `choice-${index}`, text, action, literal };
  });
}
