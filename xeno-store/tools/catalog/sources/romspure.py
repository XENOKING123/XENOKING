"""romspure.cc — PS4/PS5 categories through the generic WordPress adapter (SPEC §17.10)."""
from __future__ import annotations

import re

from sources.base import SourceSpec
from sources.wpsite import SiteConfig, online_for

SITE = SiteConfig(
    id="romspure", name="Romspure", base="https://romspure.cc", provider="Romspure", priority=25, budget=200.0,
    platforms={"PS5": ["ps5", "playstation-5"], "PS4": ["ps4", "playstation-4"]},
    category_urls={"PS5": ["https://romspure.cc/roms/ps5/"], "PS4": ["https://romspure.cc/roms/ps4/"]},
    default_platform="PS4", skip_url_re=re.compile(r"/(?:emulators?|bios)(?:/|$)", re.I),
    description="romspure.cc PS4/PS5 listings",
)

SOURCE = SourceSpec(
    id=SITE.id, name=SITE.name, priority=SITE.priority, budget=SITE.budget, release_source_ids=(SITE.id,),
    online=online_for(SITE), snapshot=None, description=SITE.description,
)
