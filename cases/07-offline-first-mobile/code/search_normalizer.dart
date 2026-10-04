/// Arabic-aware substring matching for the catalog search boxes.
///
/// A plain `LIKE '%term%'` is too literal for names typed by hand:
///
///   * The definite article "ال" changes the first letters, so a search for
///     "الجرس" misses a row stored as "جرس" and the other way round.
///   * Diacritics and the tatweel stretch are typed inconsistently and almost
///     never match.
///   * Alef, hamza, ta-marbuta and alef-maqsura have several spellings in
///     common use; a user will type one and the row will hold another.
///
/// [normalizeArabicSearch] folds all of those to a single canonical form so
/// the comparison reduces to a substring test on both sides.
library;

/// Folds one string to its searchable form: lower-cased, stripped of
/// diacritics and tatweel, letter variants unified, whitespace collapsed, and
/// a single leading definite article removed.
String normalizeArabicSearch(final String input) {
  var value = input.trim().toLowerCase();
  if (value.isEmpty) return value;

  // Combining marks (U+064B..U+0652 plus the superscript alef) and tatweel.
  value = value.replaceAll(_diacriticsAndTatweel, '');

  // Alef with any hamza or madda folds to the bare alef.
  value = value.replaceAll(_alefVariants, '\u0627');

  // Standalone hamza, waw-hamza and yeh-hamza also fold to alef, which is how
  // they are typed in practice.
  value = value.replaceAll(_hamzaVariants, '\u0627');

  // Ta-marbuta reads as heh, and alef-maqsura as yeh, at the end of a word.
  value = value.replaceAll('\u0629', '\u0647');
  value = value.replaceAll('\u0649', '\u064A');

  value = value.replaceAll(RegExp(r'\s+'), ' ');

  // Drop one leading definite article so "الجرس" and "جرس" collapse together.
  if (value.startsWith('\u0627\u0644')) {
    value = value.substring(2);
  }

  return value;
}

/// True when every already-normalized token appears in [haystack].
///
/// Tokens are expected to come from [arabicSearchTokens]; passing raw input
/// here would compare normalized text against un-normalized needles and miss.
bool arabicSearchMatches(
  final String haystack,
  final Iterable<String> tokens,
) {
  if (tokens.isEmpty) return true;
  final normalized = normalizeArabicSearch(haystack);
  for (final token in tokens) {
    if (token.isEmpty) continue;
    if (!normalized.contains(token)) return false;
  }
  return true;
}

/// Splits [query] on whitespace and normalizes each piece.
List<String> arabicSearchTokens(final String query) {
  return query
      .split(RegExp(r'\s+'))
      .map(normalizeArabicSearch)
      .where((final token) => token.isNotEmpty)
      .toList();
}

// ── Private patterns ───────────────────────────────────────────────────────

final _diacriticsAndTatweel = RegExp(r'[\u064B-\u0652\u0670\u0640]');
final _alefVariants = RegExp('[\u0622\u0623\u0625\u0671]');
final _hamzaVariants = RegExp('[\u0621\u0624\u0626]');
