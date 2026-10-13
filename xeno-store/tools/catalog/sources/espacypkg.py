"""espacypkg.com — PS4/PS5 package pages through the generic WordPress adapter (SPEC §17.10)."""
from __future__ import annotations

from sources.base import SourceSpec
from sources.wpsite import SiteConfig, online_for

SITE = SiteConfig(
    id="espacypkg", name="Espacypkg", base="https://espacypkg.com", provider="Espacypkg", priority=25, budget=200.0,
    platforms={"PS5": ["ps5"], "PS4": ["ps4"]},
    category_urls={"PS5": ["https://espacypkg.com/category/ps5/"], "PS4": ["https://espacypkg.com/category/ps4/"]},
    default_platform="PS4", description="espacypkg.com PS4/PS5 package pages",
)

SOURCE = SourceSpec(
    id=SITE.id, name=SITE.name, priority=SITE.priority, budget=SITE.budget, release_source_ids=(SITE.id,),
    online=online_for(SITE), snapshot=None, description=SITE.description,
)
