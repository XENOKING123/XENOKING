"""romsfun.com — PS4/PS5 categories through the generic WordPress adapter (SPEC §17.10)."""
from __future__ import annotations

import re

from sources.base import SourceSpec
from sources.wpsite import SiteConfig, online_for

SITE = SiteConfig(
    id="romsfun", name="Romsfun", base="https://romsfun.com", provider="Romsfun", priority=25, budget=200.0,
    platforms={"PS5": ["playstation-5", "ps5"], "PS4": ["playstation-4", "ps4"]},
    category_urls={"PS5": ["https://romsfun.com/roms/playstation-5/"], "PS4": ["https://romsfun.com/roms/playstation-4/"]},
    default_platform="PS4", skip_url_re=re.compile(r"/(?:emulators?|bios|roms/(?!playstation-[45]/)[a-z0-9-]+/?$)", re.I),
    description="romsfun.com PS4/PS5 listings",
)

SOURCE = SourceSpec(
    id=SITE.id, name=SITE.name, priority=SITE.priority, budget=SITE.budget, release_source_ids=(SITE.id,),
    online=online_for(SITE), snapshot=None, description=SITE.description,
)
