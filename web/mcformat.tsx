/**
 * Minecraft legacy formatting codes, rendered as what they mean.
 *
 * `§x` pairs carry colour and style through logs and RCON replies. Rendering
 * them raw is noise; stripping them loses information the server chose to
 * send. So: the sixteen colours and the four mappable styles render as
 * themselves, `§k` (obfuscated) and anything unknown is stripped, and `§r`
 * resets. A colour code also resets styles, which is vanilla's own rule.
 *
 * The dark colours (§0, §1) genuinely exist and genuinely vanish on a dark
 * board, exactly as they do in every real Minecraft console. Honesty beats
 * legibility here: recolouring them would misreport what the server said.
 */

const COLOURS: Record<string, string> = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
}

/** The plain text, codes removed. Search and copy operate on this. */
export function stripMc(text: string): string {
  return text.replace(/§[0-9a-fk-orA-FK-OR]?/g, '')
}

export function hasMc(text: string): boolean {
  return text.includes('§')
}

/** Render a line, codes applied. Returns the string itself when unformatted. */
export function formatMc(text: string): React.ReactNode {
  if (!text.includes('§')) return text

  const out: React.ReactNode[] = []
  let colour: string | null = null
  let bold = false
  let italic = false
  let underline = false
  let strike = false
  let buf = ''
  let key = 0

  const flush = () => {
    if (!buf) return
    if (colour || bold || italic || underline || strike) {
      out.push(
        <span
          key={key++}
          style={{
            color: colour ?? undefined,
            fontWeight: bold ? 600 : undefined,
            fontStyle: italic ? 'italic' : undefined,
            textDecorationLine:
              underline && strike
                ? 'underline line-through'
                : underline
                  ? 'underline'
                  : strike
                    ? 'line-through'
                    : undefined,
          }}
        >
          {buf}
        </span>,
      )
    } else {
      out.push(buf)
    }
    buf = ''
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '§' && i + 1 < text.length) {
      const code = text[i + 1]!.toLowerCase()
      i++
      if (code in COLOURS) {
        flush()
        colour = COLOURS[code]!
        // Vanilla: a colour code resets the style flags.
        bold = italic = underline = strike = false
      } else if (code === 'l') {
        flush()
        bold = true
      } else if (code === 'o') {
        flush()
        italic = true
      } else if (code === 'n') {
        flush()
        underline = true
      } else if (code === 'm') {
        flush()
        strike = true
      } else if (code === 'r') {
        flush()
        colour = null
        bold = italic = underline = strike = false
      }
      // Anything else (§k obfuscated included) is stripped: unmappable.
      continue
    }
    buf += ch
  }
  flush()
  return out.length === 1 ? out[0] : out
}
