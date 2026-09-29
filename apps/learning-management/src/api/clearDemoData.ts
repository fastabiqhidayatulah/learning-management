import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { assertAdmin, getActor } from '@project/shared/server/people';
import { removeDemoData } from '../server/demo';
import { inputError } from '../server/settings-admin';

/**
 * Take the Fernwood demo out of a workspace that's ready for real use. See
 * `server/demo.ts` for what counts as demo; anything created before it was
 * loaded, or since, stays.
 *
 * `dryRun` counts what would go without deleting anything. A real run works
 * for up to ~25 seconds per call and returns `done: false` when there's more,
 * so the client calls again until it's finished (and can show progress).
 */

const Input = z.object({ dryRun: z.boolean().optional() });

const Output = z.object({
  dryRun: z.boolean(),
  done: z.boolean(),
  removed: z.number(),
  tables: z.record(z.string(), z.number()),
  detached: z.number(),
  reset: z.array(z.string()),
});

export default createEndpoint({
  description: 'Remove the demo academy’s courses, people, enrollments and history',
  authenticated: true,
  inputSchema: Input,
  outputSchema: Output,
  execute: async ({ input, context }): Promise<z.infer<typeof Output>> => {
    const actor = await getActor(context);
    assertAdmin(actor);
    const parsed = Input.safeParse(input ?? {});
    if (!parsed.success) throw inputError(parsed.error);
    return removeDemoData(actor.id, { dryRun: parsed.data.dryRun === true });
  },
});
