import { createHash } from "node:crypto";
/** Bounded replay of pending transactional journal events. */
import { JournalIntegrityError } from "./journal.js";
import { MissingProgressError, TransactionIntegrityError } from "./transaction.js";
import { IsoTimestampSchema, parseWithSchema } from "./schemas.js";
function timestamp(now) {
    try {
        return parseWithSchema(IsoTimestampSchema, now(), "recovery timestamp");
    }
    catch {
        throw new TransactionIntegrityError();
    }
}
export class RecoveryService {
    journal;
    transaction;
    now;
    constructor(options) {
        this.journal = options.journal;
        this.transaction = options.transaction;
        this.now = options.now ?? (() => new Date().toISOString());
    }
    async recover() {
        let events;
        let receipts;
        try {
            [events, receipts] = await Promise.all([this.journal.listEvents(), this.journal.listReceipts()]);
        }
        catch (error) {
            if (error instanceof JournalIntegrityError)
                throw new TransactionIntegrityError();
            throw error;
        }
        const terminal = new Set(receipts.map((receipt) => receipt.event_id));
        const pending = events.filter((event) => event.kind === "apply" && !terminal.has(event.event_id));
        if (pending.length === 0)
            return { kind: "nothing_pending" };
        const completed = [];
        const deferred = [];
        const failed = [];
        for (const event of pending) {
            try {
                const outcome = await this.transaction.recoverEvent(event);
                if (outcome.kind === "applied" || outcome.kind === "already_applied")
                    completed.push(event.event_id);
                else if (outcome.kind === "deferred_conflict")
                    deferred.push(event.event_id);
                else
                    failed.push(event.event_id);
            }
            catch (error) {
                if (error instanceof MissingProgressError)
                    failed.push(event.event_id);
                else if (error instanceof TransactionIntegrityError)
                    throw error;
                else
                    failed.push(event.event_id);
            }
        }
        // Content-bound marker: a deterministic digest of the (sorted) outcome
        // sets, never the wall clock. Two recoveries that settle the same set of
        // events produce the same marker so callers can dedupe via the journal
        // idempotency key, while any new pending event forces a different
        // marker so the recovery audit remains unique.
        const sortedCompleted = [...completed].sort((left, right) => String(left).localeCompare(String(right)));
        const sortedDeferred = [...deferred].sort((left, right) => String(left).localeCompare(String(right)));
        const sortedFailed = [...failed].sort((left, right) => String(left).localeCompare(String(right)));
        const createdAt = timestamp(this.now);
        const digest = createHash("sha256")
            .update(JSON.stringify({ completed: sortedCompleted, deferred: sortedDeferred, failed: sortedFailed }), "utf8")
            .digest("hex");
        const eventId = `recover-${digest.slice(0, 32)}`;
        const priorMarker = events.find((event) => event.event_id === eventId);
        if (priorMarker === undefined) {
            await this.journal.writeEvent({ version: 1, kind: "recover", event_id: eventId, idempotency_key: digest, created_at: createdAt, recovered_event_ids: sortedCompleted });
        }
        else if (priorMarker.kind !== "recover" || priorMarker.idempotency_key !== digest || JSON.stringify(priorMarker.recovered_event_ids) !== JSON.stringify(sortedCompleted)) {
            throw new TransactionIntegrityError();
        }
        return { kind: "recovered", event_id: eventId, completed_event_ids: completed, deferred_event_ids: deferred, failed_event_ids: failed };
    }
}
