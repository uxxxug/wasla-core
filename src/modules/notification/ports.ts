import type { NotificationChannelType, NotificationMessage } from "./domain.js";

/**
 * What a channel adapter answers.
 *
 * Four outcomes, as a discriminated union, and none of them is a boolean or a
 * void. That is the point of the type:
 *
 *  - `accepted`      the provider took the message and did not say it arrived.
 *                    The honest answer for SMS, email and most push providers.
 *  - `delivered`     the provider confirmed it arrived. Only ever returned when
 *                    the provider actually says so.
 *  - `retryable`     transport or provider is unwell — timeout, 5xx, rate limit.
 *                    Sending the same bytes later can succeed.
 *  - `permanent`     the provider understood and refused: unknown address,
 *                    blocked recipient, malformed request. Repeating it wastes
 *                    attempts and delays somebody noticing.
 *
 * A `void` return would make every send look successful, and a `boolean` would
 * force the dispatcher to guess whether `false` means "try again in a minute"
 * or "this address does not exist" — the difference between a message that
 * arrives late and one that never arrives while the queue pretends otherwise.
 *
 * `provider_message_id` is carried whenever the provider gives one, so an
 * operator can take a CORE notification to a provider console. It is optional
 * because plenty of providers return nothing.
 */
export type ChannelResult =
  | { outcome: "accepted"; provider_message_id?: string | null }
  | { outcome: "delivered"; provider_message_id?: string | null }
  | {
      outcome: "retryable";
      reason: string;
      /** Honoured over the computed backoff when a provider asks for a delay. */
      retry_after_ms?: number;
      provider_message_id?: string | null;
    }
  | { outcome: "permanent"; reason: string; provider_message_id?: string | null };

/**
 * One channel. The only place in CORE allowed to talk to a messaging provider.
 *
 * A sibling of `EventTransport`, and a port for the same reasons: no domain or
 * application code imports a provider SDK, the dispatcher can be tested against
 * every outcome without a network, and swapping a fake for a real provider
 * changes this adapter and nothing above it.
 *
 * `send` receives a `NotificationMessage` — a published contract — rather than
 * the stored row, so an adapter cannot come to depend on CORE's storage shape.
 *
 * An adapter must not throw for an expected failure; it returns `retryable` or
 * `permanent`. A thrown error is treated as retryable by the dispatcher,
 * because an unknown fault is not evidence that the message was refused.
 */
export interface NotificationChannel {
  readonly channel: NotificationChannelType;
  send(message: NotificationMessage): Promise<ChannelResult>;
}

/**
 * Resolves an identity's address on a channel.
 *
 * A port, implemented in the composition root over `IdentityService`, because
 * addresses live on identity links (ADR 0016) and this module must not read
 * another module's storage (ADR 0017). Returns null when the identity has no
 * verified link for that channel — an unverified address is not somewhere CORE
 * may send anything, since an unverified link is a claim nobody has checked.
 */
export interface ChannelDirectory {
  verifiedAddress(identityId: string, channel: NotificationChannelType): Promise<string | null>;
}
