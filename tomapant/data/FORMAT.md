# Word library format for Țomapant

Each category is a UTF-8 plain-text file, one entry per line.

    Canonical = variant1 = variant2

* The canonical form is the conventional Romanian name, spelled with correct
  Romanian diacritics: ă â î ș ț (comma-below). NEVER the cedilla forms ş ţ.
* Variants (optional, after " = ") are other accepted spellings or names of the
  SAME thing: native or English forms, alternative Romanian names, common
  alternative spellings (Londra = London; Olanda = Țările de Jos = Netherlands;
  Dunărea = Dunăre = Danube; München = Munchen = Munich).
  Do not list diacritic-free spellings as variants: lookups already ignore
  diacritics, so "Brasov" automatically matches "Brașov".
* Proper nouns are capitalised the normal way (Brașov, Marea Neagră, Vârful Omu).
  Plants and animals are written in lowercase (lup, trandafir, ciuboțica-cucului).
* Lines starting with # are comments and are ignored. Blank lines are ignored.
* No numbering, no bullets, no trailing spaces, no tabs, no explanations on the
  line, no quotation marks, no parentheses with notes.
* One real thing per line. Never invent entries, never pad, never guess.
  If you are not sure something exists or how it is spelled, leave it out.
* Within one file every entry (canonical or variant) must be unique.
  Lookups strip diacritics and spaces, so "Dunăre" and "Dunare" count as the
  same key; do not list both.
* Generic leading words are stripped automatically before lookup, both in the
  file and in the players' answers. So the following are fine and are keyed
  by the word that follows:
    Țări:  republica, regatul, statul, principatul, ducatul
    Orașe: orașul, municipiul, comuna, satul
    Munți: munții, muntele, masivul, vârful, vf, culmea, dealul, dealurile
    Ape:   râul, raul, fluviul, pârâul, lacul, marea, oceanul, golful,
           strâmtoarea, canalul, cascada, delta, balta
  Prefer the bare name where natural ("Retezat" rather than "Munții Retezat",
  "Dunărea" rather than "Râul Dunărea", "Bâlea" rather than "Lacul Bâlea"),
  but seas and oceans are written in full ("Marea Neagră", "Oceanul Atlantic")
  and are then keyed by the second word (N, A).
* Lookups also ignore hyphens, apostrophes and dots, and collapse spaces.
* The first letter that counts in the game is the first letter of the
  canonical entry after the generic word is stripped. Ș and Ț are letters of
  their own (șarpe is an Ș word, not an S word). Ă and Â count as A; Î as I.
