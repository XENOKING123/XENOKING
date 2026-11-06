/**
 * Identify a licence from LICENSE file text and say whether it permits redistribution.
 * Unknown / missing licence => all rights reserved => redistribution NOT granted.
 */
export interface LicenseInfo {
  spdx: string | null;
  redistributable: boolean;
  note: string;
}

const RULES: Array<[RegExp, string, boolean, string]> = [
  [/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/i, 'AGPL-3.0', true, 'copyleft; redistribution allowed with licence + attribution'],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL', true, 'copyleft; redistribution allowed with licence + attribution'],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 3/i, 'GPL-3.0', true, 'copyleft; redistribution allowed with licence + attribution'],
  [/GNU GENERAL PUBLIC LICENSE\s+Version 2/i, 'GPL-2.0', true, 'copyleft; redistribution allowed with licence + attribution'],
  [/Mozilla Public License,?\s+(Version|v\.?)\s*2\.0/i, 'MPL-2.0', true, 'redistribution allowed with licence notice'],
  [/Apache License,?\s+Version 2\.0/i, 'Apache-2.0', true, 'redistribution allowed with licence + notices'],
  [/This is free and unencumbered software released into the public domain/i, 'Unlicense', true, 'public domain dedication'],
  [/CC0 1\.0 Universal|Creative Commons Zero/i, 'CC0-1.0', true, 'public domain dedication'],
  [/Attribution-NonCommercial/i, 'CC-BY-NC', false, 'non-commercial only — needs owner review before mirroring'],
  [/Attribution-NoDerivatives|Attribution-NoDerivs/i, 'CC-BY-ND', true, 'verbatim redistribution allowed with attribution'],
  [/Attribution-ShareAlike/i, 'CC-BY-SA', true, 'redistribution allowed with attribution, same licence'],
  [/Creative Commons Attribution/i, 'CC-BY', true, 'redistribution allowed with attribution'],
  [/Permission is hereby granted, free of charge, to any person obtaining a copy/i, 'MIT', true, 'redistribution allowed with copyright notice'],
  [/Redistribution and use in source and binary forms, with or without\s+modification, are permitted/i, 'BSD', true, 'redistribution allowed with notice'],
  [/ISC License|Permission to use, copy, modify, and\/or distribute this software for any/i, 'ISC', true, 'redistribution allowed with notice'],
];

export function detectLicense(text: string | null | undefined): LicenseInfo {
  if (!text || !text.trim()) return { spdx: null, redistributable: false, note: 'no licence file: all rights reserved by default' };
  for (const [re, spdx, ok, note] of RULES) if (re.test(text)) return { spdx, redistributable: ok, note };
  return { spdx: null, redistributable: false, note: 'unrecognised licence text — owner review required' };
}
