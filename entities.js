// Named character reference table (compact subset of the HTML standard
// entities, covering Latin-1, Greek, punctuation, arrows and math symbols)
// plus lookup helpers used by the parser for attribute decoding.

const RAW =
  'amp:& lt:< gt:> quot:" apos:\' iexcl:¡ cent:¢ pound:£ curren:¤ yen:¥ brvbar:¦ sect:§ uml:¨ copy:© ordf:ª laquo:« not:¬ shy:­ reg:® macr:¯ deg:° plusmn:± sup2:² sup3:³ acute:´ micro:µ para:¶ middot:· cedil:¸ sup1:¹ ordm:º raquo:» frac14:¼ frac12:½ frac34:¾ iquest:¿ ' +
  'Agrave:À Aacute:Á Acirc:Â Atilde:Ã Auml:Ä Aring:Å AElig:Æ Ccedil:Ç Egrave:È Eacute:É Ecirc:Ê Euml:Ë Igrave:Ì Iacute:Í Icirc:Î Iuml:Ï ETH:Ð Ntilde:Ñ Ograve:Ò Oacute:Ó Ocirc:Ô Otilde:Õ Ouml:Ö times:× Oslash:Ø Ugrave:Ù Uacute:Ú Ucirc:Û Uuml:Ü Yacute:Ý THORN:Þ szlig:ß ' +
  'agrave:à aacute:á acirc:â atilde:ã auml:ä aring:å aelig:æ ccedil:ç egrave:è eacute:é ecirc:ê euml:ë igrave:ì iacute:í icirc:î iuml:ï eth:ð ntilde:ñ ograve:ò oacute:ó ocirc:ô otilde:õ ouml:ö divide:÷ oslash:ø ugrave:ù uacute:ú ucirc:û uuml:ü yacute:ý thorn:þ yuml:ÿ ' +
  'Alpha:Α Beta:Β Gamma:Γ Delta:Δ Epsilon:Ε Zeta:Ζ Eta:Η Theta:Θ Iota:Ι Kappa:Κ Lambda:Λ Mu:Μ Nu:Ν Xi:Ξ Omicron:Ο Pi:Π Rho:Ρ Sigma:Σ Tau:Τ Upsilon:Υ Phi:Φ Chi:Χ Psi:Ψ Omega:Ω ' +
  'alpha:α beta:β gamma:γ delta:δ epsilon:ε zeta:ζ eta:η theta:θ iota:ι kappa:κ lambda:λ mu:μ nu:ν xi:ξ omicron:ο pi:π rho:ρ sigmaf:ς sigma:σ tau:τ upsilon:υ phi:φ chi:χ psi:ψ omega:ω thetasym:ϑ upsih:ϒ piv:ϖ ' +
  'bull:• hellip:… prime:′ Prime:″ oline:‾ frasl:⁄ weierp:℘ image:ℑ real:ℜ trade:™ alefsym:ℵ larr:← uarr:↑ rarr:→ darr:↓ harr:↔ crarr:↵ lArr:⇐ uArr:⇑ rArr:⇒ dArr:⇓ hArr:⇔ ' +
  'forall:∀ exist:∃ empty:∅ nabla:∇ isin:∈ notin:∉ ni:∋ prod:∏ sum:∑ minus:− lowast:∗ radic:√ prop:∝ infin:∞ ang:∠ and:∧ or:∨ cap:∩ cup:∪ int:∫ there4:∴ sim:∼ cong:≅ asymp:≈ ne:≠ equiv:≡ le:≤ ge:≥ sub:⊂ sup:⊃ nsub:⊄ sube:⊆ supe:⊇ oplus:⊕ otimes:⊗ perp:⊥ sdot:⋅ ' +
  'lceil:⌈ rceil:⌉ lfloor:⌊ rfloor:⌋ lang:⟨ rang:⟩ loz:◊ spades:♠ clubs:♣ hearts:♥ diams:♦ zwnj:‌ zwj:‍ lrm:‎ rlm:‏ ndash:– mdash:— lsquo:\' rsquo:\' sbquo:‚ ldquo:" rdquo:" bdquo:„ dagger:† Dagger:‡ permil:‰ lsaquo:‹ rsaquo:› euro:€ ' +
  'OElig:Œ oelig:œ Scaron:Š scaron:š Yuml:Ÿ fnof:ƒ circ:ˆ tilde:˜ ' +
  'Tab:\t NewLine:\n colon:: semi:; comma:, period:. quest:? excl:! sol:/ bsol:\\ lpar:( rpar:) lcub:{ rcub:} lsqb:[ rsqb:] dollar:$ percnt:% ast:* plus:+ equals:= ' +
  'Dcaron:Ď dcaron:ď HilbertSpace:ℋ DifferentialD:ⅆ ClockwiseContourIntegral:∳ ngE:≱ CounterClockwiseContourIntegral:∲ DoubleLongLeftRightArrow:⟺ NotGreaterFullEqual:≱̸';

export const namedEntities = Object.create(null);
for (const pair of RAW.split(' ')) {
  if (!pair) continue;
  const idx = pair.indexOf(':');
  namedEntities[pair.slice(0, idx)] = pair.slice(idx + 1);
}
// A few long names whose values cannot ride the compact encoding above.
namedEntities['NotEqualTilde'] = '≂̸';
namedEntities['DoubleDot'] = '¨';
namedEntities['UnderBar'] = '_';
namedEntities['hyphen'] = '‐';
namedEntities['fjlig'] = 'fj';
namedEntities['ThickSpace'] = '  ';
namedEntities['nbsp'] = ' ';
namedEntities['ensp'] = ' ';
namedEntities['emsp'] = ' ';
namedEntities['thinsp'] = ' ';
namedEntities['enspace'] = ' ';
namedEntities['emspace'] = ' ';
namedEntities['hairsp'] = ' ';

export function lookupNamedEntity(name) {
  return Object.prototype.hasOwnProperty.call(namedEntities, name)
    ? namedEntities[name]
    : undefined;
}

export function codePointToChar(cp) {
  if (
    cp === 0 ||
    cp > 0x10ffff ||
    (cp >= 0xd800 && cp <= 0xdfff)
  ) {
    return '�';
  }
  return String.fromCodePoint(cp);
}

export function decodeEntityBody(body) {
  if (body.charAt(0) === '#') {
    if (body.charAt(1) === 'x' || body.charAt(1) === 'X') {
      const cp = parseInt(body.slice(2), 16);
      return Number.isNaN(cp) ? undefined : codePointToChar(cp);
    }
    const cp = parseInt(body.slice(1), 10);
    return Number.isNaN(cp) ? undefined : codePointToChar(cp);
  }
  return lookupNamedEntity(body);
}
