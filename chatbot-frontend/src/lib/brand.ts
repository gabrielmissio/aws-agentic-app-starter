import { UtensilsCrossed, type LucideIcon } from 'lucide-react'

/**
 * Everything that makes this demo *this* demo.
 *
 * The rest of the app renders the brand through these three values and the colour tokens in
 * `styles.css`. Starting a different AP2 project means editing this file and those tokens — the
 * components, the checkout card and the Explorer carry no product identity of their own.
 *
 * The name and tagline live here rather than in the message catalogs because a product name is not
 * translated; the sentences *around* it are, and those stay in `lib/i18n/messages/`.
 */
export const BRAND: { name: string; tagline: string; icon: LucideIcon } = {
  name: 'TastyGo',
  tagline: 'AP2 · AgentCore',
  /** The agent's face: shown in the header, next to every agent message, and on the auth screen. */
  icon: UtensilsCrossed,
}
