import { z } from "zod";

export const eventSchema = z
  .object({
    id: z.uuid(),
    attemptId: z.uuid(),
    occurredAt: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v).toISOString()),
    kind: z.enum([
      "finding",
      "decision",
      "progress",
      "test",
      "blocker",
      "handoff",
      "correction",
    ]),
    summary: z.string().trim().min(1).max(500),
    detail: z.string().max(15000).default(""),
    evidence: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(200),
            kind: z.enum(["file", "commit", "test", "link"]),
            reference: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    corrects: z.uuid().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if ((e.kind === "correction") !== Boolean(e.corrects))
      ctx.addIssue({
        code: "custom",
        message:
          "A correction must reference an earlier event; only corrections may use corrects.",
      });
  });
export type EventInput = z.infer<typeof eventSchema>;
export interface WorkEvent extends Omit<EventInput, "attemptId" | "kind"> {
  attemptId: string | null;
  kind: EventInput["kind"] | "claim" | "report" | "credential";
  sequence: number;
  sessionId: string;
  receivedAt: string;
  actor: string;
  source: "agent" | "workroom";
  conversation: { agent: string; id: string } | null;
  historical: boolean;
}
export interface EventPage {
  events: WorkEvent[];
  nextCursor: number;
  hasMore: boolean;
}
export const conversationSchema = z
  .object({
    agent: z.string().trim().min(1).max(100),
    id: z.string().trim().min(1).max(500),
  })
  .strict();
export interface ReportingAttempt {
  id: string;
  sessionId: string;
  actor: string;
  createdAt: string;
  conversation: z.infer<typeof conversationSchema> | null;
  reportHash: string;
  leaseHash: string;
  credentialVersion?: number;
  revokedAt?: string;
  rotatedAt?: string;
}

export type ReportingAccess = Omit<
  ReportingAttempt,
  "reportHash" | "leaseHash"
> & {
  credentialVersion: number;
  status: "active" | "revoked";
};
