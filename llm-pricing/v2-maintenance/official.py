"""Parsers for the official tables the refresh reads directly; dependency-free.

Databricks publishes model-serving regions (per cloud) and DBU rates as HTML tables, and Bedrock
model cards mark each region's in-region / geographic / global support with icons. These parsers
turn them into region lists and USD rates that update-endpoints.py and review-sources.py compare
with the published data.
"""
from html.parser import HTMLParser
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
NOTICE = re.compile(r"promot|discount|expir|retir|deprecat|through\s+(?:\w+\s+)?\d|until\s+(?:\w+\s+)?\d|long.context|not.supported|cache.writ|cache.storage|higher.context", re.I)


def clean(text):
    return re.sub(r"\s+", " ", text).strip()


class Page(HTMLParser):
    """Visible headings, tables, links and billing/lifecycle notices, sans menus."""
    SKIP = {"head", "script", "style", "nav", "header", "footer", "noscript", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ignored = []
        self.text = []
        self.headings = {}
        self.heading_tag = None
        self.heading_text = []
        self.tables = []
        self.table = None
        self.row = None
        self.cell = None
        self.notices = []
        self.paragraphs = []
        self.blocks = []
        self.block_tags = []
        self.links = []

    def finish_cell(self):
        if self.cell is not None and self.row is not None:
            self.row.append(clean(" ".join(self.cell)))
        self.cell = None

    def finish_row(self):
        self.finish_cell()
        if self.row is not None and self.table is not None and any(self.row):
            self.table["rows"].append(self.row)
        self.row = None

    def finish_block(self):
        if self.blocks:
            text = clean(" ".join(self.blocks.pop()))
            self.block_tags.pop()
            if len(text) >= 20:
                self.paragraphs.append(text)
                if NOTICE.search(text):
                    self.notices.append(text)

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.ignored.append(tag)
        if self.ignored:
            return
        # Minified documentation legitimately omits </p>, </td>, </th> and </tr>.
        # Honor their implied closing points instead of dropping entire tables.
        if self.block_tags and self.block_tags[-1] == "p" and tag in {"p", "td", "th", "tr", "tbody", "thead", "table", "div", "h1", "h2", "h3", "h4"}:
            self.finish_block()
        if self.block_tags and self.block_tags[-1] == "li" and tag == "li":
            self.finish_block()
        if re.fullmatch(r"h[1-6]", tag):
            self.heading_tag = tag
            self.heading_text = []
        if tag == "table" and self.table is None:
            self.table = {"heading": " / ".join(self.headings[k] for k in sorted(self.headings)), "rows": []}
        elif tag == "tr" and self.table is not None:
            self.finish_row()
            self.row = []
        elif tag in {"th", "td"} and self.row is not None:
            self.finish_cell()
            self.cell = []
        elif tag in {"thead", "tbody", "tfoot"} and self.table is not None:
            self.finish_row()
        if tag in {"p", "li", "aside", "blockquote"}:
            self.blocks.append([])
            self.block_tags.append(tag)
        if tag == "a":
            href = dict(attrs).get("href", "")
            if href:
                self.links.append(href)

    def handle_data(self, text):
        if self.ignored:
            return
        if text.strip():
            self.text.append(text)
        if self.heading_tag:
            self.heading_text.append(text)
        if self.cell is not None:
            self.cell.append(text)
        for block in self.blocks:
            block.append(text)

    def handle_endtag(self, tag):
        if self.ignored:
            if tag in self.ignored:
                # Pop only the corresponding ignored tag, not ordinary nested tags.
                for n in range(len(self.ignored) - 1, -1, -1):
                    if self.ignored[n] == tag:
                        del self.ignored[n:]
                        break
            return
        if tag == self.heading_tag:
            level = int(tag[1])
            self.headings = {k: v for k, v in self.headings.items() if k < level}
            self.headings[level] = clean(" ".join(self.heading_text))
            self.heading_tag = None
        if tag in {"th", "td"} and self.cell is not None:
            self.finish_cell()
        if tag == "tr" and self.row is not None:
            self.finish_row()
        if tag == "table" and self.table is not None:
            self.finish_row()
            if self.table["rows"]:
                self.tables.append(self.table)
            self.table = None
        if tag in {"p", "li", "aside", "blockquote"} and self.blocks:
            self.finish_block()



GEOS = ("Americas", "Europe", "APAC")

# Region code -> (geography, name shown on the page). Middle East / Africa and GovCloud are not
# shown (the page covers the Americas, Europe and APAC, with Hong Kong and Taiwan called out).
AWS = {
    "us-east-1": ("Americas", "N. Virginia"), "us-east-2": ("Americas", "Ohio"), "us-west-1": ("Americas", "N. California"),
    "us-west-2": ("Americas", "Oregon"), "ca-central-1": ("Americas", "Canada"), "ca-west-1": ("Americas", "Calgary"),
    "mx-central-1": ("Americas", "Mexico"), "sa-east-1": ("Americas", "São Paulo"),
    "eu-central-1": ("Europe", "Frankfurt"), "eu-central-2": ("Europe", "Zurich"), "eu-west-1": ("Europe", "Ireland"),
    "eu-west-2": ("Europe", "London"), "eu-west-3": ("Europe", "Paris"), "eu-north-1": ("Europe", "Stockholm"),
    "eu-south-1": ("Europe", "Milan"), "eu-south-2": ("Europe", "Spain"),
    "ap-east-1": ("APAC", "Hong Kong"), "ap-east-2": ("APAC", "Taipei"), "ap-northeast-1": ("APAC", "Tokyo"),
    "ap-northeast-2": ("APAC", "Seoul"), "ap-northeast-3": ("APAC", "Osaka"), "ap-south-1": ("APAC", "Mumbai"),
    "ap-south-2": ("APAC", "Hyderabad"), "ap-southeast-1": ("APAC", "Singapore"), "ap-southeast-2": ("APAC", "Sydney"),
    "ap-southeast-3": ("APAC", "Jakarta"), "ap-southeast-4": ("APAC", "Melbourne"), "ap-southeast-5": ("APAC", "Malaysia"),
    "ap-southeast-6": ("APAC", "New Zealand"), "ap-southeast-7": ("APAC", "Thailand"),
}
AZURE = {
    "eastus": ("Americas", "East US"), "eastus2": ("Americas", "East US 2"), "centralus": ("Americas", "Central US"),
    "northcentralus": ("Americas", "North Central US"), "southcentralus": ("Americas", "South Central US"),
    "westcentralus": ("Americas", "West Central US"), "westus": ("Americas", "West US"), "westus2": ("Americas", "West US 2"),
    "westus3": ("Americas", "West US 3"), "canadacentral": ("Americas", "Canada Central"), "canadaeast": ("Americas", "Canada East"),
    "brazilsouth": ("Americas", "Brazil South"), "mexicocentral": ("Americas", "Mexico Central"),
    "northeurope": ("Europe", "North Europe"), "westeurope": ("Europe", "West Europe"), "uksouth": ("Europe", "UK South"),
    "ukwest": ("Europe", "UK West"), "francecentral": ("Europe", "France Central"), "germanywestcentral": ("Europe", "Germany West Central"),
    "swedencentral": ("Europe", "Sweden Central"), "switzerlandnorth": ("Europe", "Switzerland North"),
    "switzerlandwest": ("Europe", "Switzerland West"), "norwayeast": ("Europe", "Norway East"), "polandcentral": ("Europe", "Poland Central"),
    "italynorth": ("Europe", "Italy North"), "spaincentral": ("Europe", "Spain Central"),
    "eastasia": ("APAC", "East Asia (Hong Kong)"), "southeastasia": ("APAC", "Southeast Asia (Singapore)"),
    "japaneast": ("APAC", "Japan East"), "japanwest": ("APAC", "Japan West"), "koreacentral": ("APAC", "Korea Central"),
    "koreasouth": ("APAC", "Korea South"), "centralindia": ("APAC", "Central India"), "southindia": ("APAC", "South India"),
    "westindia": ("APAC", "West India"), "australiaeast": ("APAC", "Australia East"), "australiasoutheast": ("APAC", "Australia Southeast"),
    "australiacentral": ("APAC", "Australia Central"), "australiacentral2": ("APAC", "Australia Central 2"),
    "newzealandnorth": ("APAC", "New Zealand North"), "indonesiacentral": ("APAC", "Indonesia Central"),
    "malaysiawest": ("APAC", "Malaysia West"), "chinaeast2": ("APAC", "China East 2"), "chinaeast3": ("APAC", "China East 3"),
    "chinanorth2": ("APAC", "China North 2"), "chinanorth3": ("APAC", "China North 3"),
}
GCP = {
    "us-central1": ("Americas", "Iowa"), "us-east1": ("Americas", "S. Carolina"), "us-east4": ("Americas", "N. Virginia"),
    "us-east5": ("Americas", "Columbus"), "us-south1": ("Americas", "Dallas"), "us-west1": ("Americas", "Oregon"),
    "us-west4": ("Americas", "Las Vegas"), "northamerica-northeast1": ("Americas", "Montréal"),
    "southamerica-east1": ("Americas", "São Paulo"),
    "europe-west1": ("Europe", "Belgium"), "europe-west2": ("Europe", "London"), "europe-west3": ("Europe", "Frankfurt"),
    "europe-west4": ("Europe", "Netherlands"), "europe-west8": ("Europe", "Milan"), "europe-west9": ("Europe", "Paris"),
    "europe-north1": ("Europe", "Finland"), "europe-southwest1": ("Europe", "Madrid"),
    "asia-east1": ("APAC", "Taiwan"), "asia-east2": ("APAC", "Hong Kong"), "asia-northeast1": ("APAC", "Tokyo"),
    "asia-northeast3": ("APAC", "Seoul"), "asia-south1": ("APAC", "Mumbai"), "asia-southeast1": ("APAC", "Singapore"),
    "australia-southeast1": ("APAC", "Sydney"),
}
CLOUDS = {"aws": ("AWS", AWS), "azure": ("Azure", AZURE), "gcp": ("GCP", GCP)}
HONG_KONG = {"aws": "ap-east-1", "azure": "eastasia", "gcp": "asia-east2"}
TAIWAN = {"aws": "ap-east-2", "gcp": "asia-east1"}


def tables(html):
    page = Page()
    page.feed(html)
    return page.tables


def norm(name):
    """Comparable model name: lowercase, '-' and '_' as spaces, footnote and region marks removed."""
    name = re.sub(r"[*⌖†⥂]", " ", name.lower())
    return re.sub(r"\s+", " ", re.sub(r"[-_]", " ", name)).strip()


def compact(name):
    """Looser key for matching a page's model name to a table row: no parentheses or spaces."""
    return re.sub(r"[\s_-]+", "", re.sub(r"\(.*?\)", "", norm(name)))


def expand_names(label):
    """'Claude Opus 4.5, 4.6, 5' -> ['Claude Opus 4.5', 'Claude Opus 4.6', 'Claude Opus 5']."""
    parts = [p.strip() for p in re.sub(r"[*⌖†]", "", label).split(",") if p.strip()]
    if not parts:
        return []
    prefix = re.match(r"^(.*?)(?=\d)", parts[0])
    prefix = prefix.group(1) if prefix else ""
    return [parts[0]] + [prefix + p if p[:1].isdigit() else p for p in parts[1:]]


# ---- Databricks model-serving regions -------------------------------------------------------

def dbx_regions(html):
    """{endpoint: {region: {"cross": bool, "adi": bool}}} from the pay-per-token column.

    ⥂ = served by cross-geography routing (needs routing enabled); † = provided through
    Databricks' ADI Services (Azure).
    """
    found = [t for t in tables(html) if t["rows"] and t["rows"][0][:2] == ["Region", "Foundation Model APIs pay-per-token"]]
    if not found:
        raise ValueError("Databricks region table not found; the page format may have changed.")
    out = {}
    for row in found[0]["rows"][1:]:
        if len(row) < 2:
            continue
        region, cell = row[0].strip(), row[1]
        for name, marks in re.findall(r"(databricks-[a-z0-9-]+)((?:\s*[⥂†‡])*)", cell):
            out.setdefault(name, {})[region] = {"cross": "⥂" in marks, "adi": "†" in marks}
    if len(out) < 10:
        raise ValueError("Too few Databricks endpoints in the region table.")
    return out


def where(cloud_lists):
    """'AWS N. Virginia, Ohio · Azure East US' from [(cloud label, [names])]."""
    return " · ".join(label + " " + ", ".join(names) for label, names in cloud_lists if names)


def dbx_endpoint_regions(endpoint, per_cloud):
    """Region entries, HK / Taiwan states and ADI flag for one Databricks endpoint.

    per_cloud = {"aws": dbx_regions(...), "azure": ..., "gcp": ...}.
    """
    lists = {(geo, level): [] for geo in GEOS for level in ("in-region", "global")}
    adi = False
    for cloud, (label, names) in CLOUDS.items():
        regions = per_cloud.get(cloud, {}).get(endpoint, {})
        by = {(geo, level): [] for geo in GEOS for level in ("in-region", "global")}
        for code, marks in regions.items():
            if code not in names:
                continue
            geo, name = names[code]
            by[(geo, "global" if marks["cross"] else "in-region")].append(name)
            adi = adi or marks["adi"]
        for key, found in by.items():
            if found:
                # Keep the cloud's own region order, as listed in the name table.
                order = [n for _, n in names.values()]
                lists[key].append((label, sorted(found, key=order.index)))
    regions = []
    for geo in GEOS:
        for level, word in (("in-region", "In-region"), ("global", "Cross-geo")):
            text = where(lists[(geo, level)])
            if text:
                regions.append([geo, level, word, text])
    azure = per_cloud.get("azure", {}).get(endpoint, {})
    hk = azure.get("eastasia")
    hk_state = ["none", "No Hong Kong region in Databricks' model-serving tables"] if hk is None else \
        ["routed", "Azure East Asia (Hong Kong) through cross-geo routing"] if hk["cross"] else \
        ["in-region", "Azure East Asia (Hong Kong), in-region"]
    tw = ["none", "No Taiwan region in Databricks' model-serving tables"]
    return dict(regions=regions, hk=hk_state, tw=tw, adi=adi)


# ---- Databricks DBU rates --------------------------------------------------------------------

def _rate(text):
    text = text.replace(",", "").strip()
    return float(text) if re.fullmatch(r"\d+(?:\.\d+)?", text) else None


def dbx_price_rows(html, usd_per_dbu):
    """{normalized model name: {"tier": {"part": {field: usd}}, "regional": bool, "label": str}}.

    tier is "standard" or "priority"; part is "", "short context", "long context" or "text tokens".
    Fields are in, out, cache_read, cache_write, cache_write_1h, in USD per 1M tokens.
    """
    out = {}
    for table in tables(html):
        rows = table["rows"]
        if len(rows) < 3:
            continue
        title = " ".join(rows[0])
        tier = "standard" if "Standard Pay Per Token" in title else "priority" if "Priority Pay Per Token" in title else None
        if not tier:
            continue
        names = {"Input": "in", "Output": "out", "Cache read": "cache_read", "Cache write": "cache_write", "Cache write (1hr)": "cache_write_1h"}
        fields = [names.get(h.strip()) for h in rows[1]]
        has_part = rows[0][1:2] == [""]
        current = None
        for row in rows[2:]:
            cells = [c.strip() for c in row]
            # A row that starts with a sub-row label continues the previous model.
            if has_part and len(cells) == len(fields) + 1 and current:
                part, values = cells[0], cells[1:]
            elif has_part and len(cells) == len(fields) + 2:
                current, part, values = cells[0], cells[1], cells[2:]
            elif not has_part and len(cells) == len(fields) + 1:
                current, part, values = cells[0], "", cells[1:]
            else:
                continue
            rates = {f: round(_rate(v) * usd_per_dbu, 6) for f, v in zip(fields, values) if f and _rate(v) is not None}
            for name in expand_names(current):
                entry = out.setdefault(norm(name), {"label": current, "regional": "⌖" in current})
                entry.setdefault(tier, {})[part.lower()] = rates
    if len(out) < 10:
        raise ValueError("Too few Databricks price rows; the page format may have changed.")
    return out


if __name__ == "__main__":
    import json
    import sys
    for path in sys.argv[1:]:
        text = Path(path).read_text()
        try:
            print(path, json.dumps(dbx_price_rows(text, 0.07), ensure_ascii=False)[:600])
        except ValueError:
            regions = dbx_regions(text)
            print(path, len(regions), "endpoints;", json.dumps(regions.get("databricks-kimi-k3"))[:400])
