import type { IdentityService } from "../identity-access/service.js";
import type { NotificationChannelType } from "./domain.js";
import type { ChannelDirectory } from "./ports.js";
import { compareValues } from "../../platform/persistence/list-order.js";

/**
 * `ChannelDirectory` over the identity module's published service.
 *
 * The adapter lives here rather than in the composition root only because it has
 * a rule to enforce, and a rule deserves a place with a comment: a link is
 * usable when `verified_at` is set, and not otherwise. An unverified link is a
 * claim nobody has checked — sending an order status, a payment demand or
 * anything else to it would be CORE handing one person's business to whoever
 * typed the address in.
 *
 * When an identity has several verified links on one channel — two phones, a
 * work and a personal email — the oldest verified one wins. Deterministic on
 * purpose: "the newest" would silently redirect a person's notifications the
 * moment they add a second address, and "all of them" would multiply every
 * message without anybody choosing that.
 */
export class IdentityChannelDirectory implements ChannelDirectory {
  constructor(private readonly identity: IdentityService) {}

  async verifiedAddress(
    identityId: string,
    channel: NotificationChannelType,
  ): Promise<string | null> {
    const links = await this.identity.channelLinks(identityId);
    const usable = links
      .filter((link) => link.channel_type === channel && link.verified_at !== null)
      .sort((a, b) => compareValues(a.verified_at ?? "", b.verified_at ?? ""));
    // `external_id` is the address as the channel issued it: a Telegram chat id,
    // an e.164 number, an email. CORE stores it and never reformats it.
    return usable[0]?.external_id ?? null;
  }
}
