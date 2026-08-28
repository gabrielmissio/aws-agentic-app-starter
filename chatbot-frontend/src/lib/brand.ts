import { Sparkles, type LucideIcon } from 'lucide-react'

/**
 * Everything that makes this app *this* app. Rebranding is this file plus the colour tokens in
 * `styles.css` — no component carries a product identity of its own.
 *
 * Not in the message catalogs, because a product name is not translated; the sentences around it are.
 */
export const BRAND: { name: string; tagline: string; icon: LucideIcon } = {
  name: 'Aria',
  tagline: 'Personal assistant · AgentCore',
  /** The agent's face: shown in the header, next to every agent message, and on the auth screen. */
  icon: Sparkles,
}
