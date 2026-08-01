import type { DimensionInfo } from '@shared/api'
import overworld from './assets/worlds/overworld.svg'
import nether from './assets/worlds/nether.svg'
import end from './assets/worlds/end.svg'
import unknown from './assets/worlds/unknown.svg'

/**
 * The world-type mark.
 *
 * Three known types get their own silhouette; everything else gets ONE
 * neutral mark that depicts nothing. That last part is the rule, not a
 * shortcut. A modded server can hold dozens of dimensions whose type we
 * genuinely cannot determine (the real fleet has fifty-four of them in flat
 * `DIM<n>` form), and drawing a plausible icon for those would produce
 * something visually indistinguishable from a correct answer. An icon is a
 * claim; this one claims only that we did not identify it.
 *
 * Two design decisions worth stating, because both look like omissions:
 *
 *   - **Monochrome.** These are tinted with `currentColor` through a CSS
 *     mask rather than shipped as coloured artwork. On this board colour
 *     means attention (DESIGN.md), and a world being the nether is not an
 *     event. Green, red and purple icons would spend the one channel
 *     reserved for faults on decoration. The forms carry the meaning.
 *   - **Static files, not inline paths.** They are real `.svg` files under
 *     `web/assets/worlds/`, bundled by the build like the logo, so a
 *     designer can replace one without touching a component.
 */

const SRC: Record<DimensionInfo['kind'], string> = {
  overworld,
  nether,
  end,
  custom: unknown,
}

const TITLE: Record<DimensionInfo['kind'], string> = {
  overworld: 'Overworld',
  nether: 'Nether',
  end: 'The End',
  custom: 'Type not identified. The icon is deliberately neutral rather than a guess.',
}

export function WorldIcon({
  kind,
  size = 14,
  className = '',
}: {
  kind: DimensionInfo['kind']
  size?: number
  className?: string
}) {
  const src = SRC[kind]
  return (
    <span
      role="img"
      aria-label={TITLE[kind]}
      title={TITLE[kind]}
      // An unidentified type is rendered dimmer than a known one, so that
      // "we did not work this out" reads as less information rather than as
      // a different fact.
      className={`inline-block shrink-0 bg-current ${kind === 'custom' ? 'opacity-55' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        // Mask rather than <img> so the mark inherits the surrounding text
        // colour and cannot introduce a hue of its own.
        //
        // The quotes around the URL are load-bearing. Vite inlines small SVGs
        // as data URIs and picks percent-encoding over base64 when it is
        // shorter, which leaves raw `'` characters in the string. An UNQUOTED
        // css url() rejects those, so the browser drops the whole declaration
        // and the element renders as a solid square: an icon that is present,
        // wrong, and says nothing about being wrong. Three of the four looked
        // identical on screen before this was found.
        maskImage: `url("${src}")`,
        WebkitMaskImage: `url("${src}")`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  )
}
