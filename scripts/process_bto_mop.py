
import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from difflib import SequenceMatcher
import pandas as pd

# Paths
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
PUBLIC_DATA_DIR = SCRIPT_DIR.parent / "public" / "data"

RAW_BTO_FILE = DATA_DIR / "bto_scrape_raw.json"
GEOJSON_FILE = DATA_DIR / "HDBPublicHousingBuildingUnderConstruction.geojson"
OUTPUT_FILE = PUBLIC_DATA_DIR / "upcoming_mop.geojson"

def parse_date(date_str):
    """
    Parses various date formats:
    - "04 Feb 2026"
    - "Feb 2026"
    - "3Q 2027"
    - "Dec 2008"
    """
    date_str = str(date_str).strip()
    if not date_str or date_str.lower() in ["cancelled", "nan", ""]:
        return None
        
    # Handle ranges "3Q 2027" -> End of Quarter
    if "Q " in date_str or "Q" in date_str:
        try:
            # simple regex for NQ YYYY
            match = re.search(r'(\d)Q\s*(\d{4})', date_str)
            if match:
                q, year = match.groups()
                # End of quarter months: Q1->Mar, Q2->Jun, Q3->Sep, Q4->Dec
                month = int(q) * 3 
                # Last day of month
                if month in [3, 12]: day = 31
                elif month in [6, 9]: day = 30
                else: day = 28
                return datetime(int(year), month, day)
        except:
            pass

    # Handle "DD Mon YYYY" or "Mon YYYY"
    for fmt in ["%d %b %Y", "%b %Y"]:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            pass
            
    return None

def normalize_name(name):
    """Normalize project name for fuzzy matching."""
    if not name: return ""
    name = str(name).lower()
    name = re.sub(r'[^a-z0-9\s]', '', name) # remove special chars
    name = re.sub(r'\s+', ' ', name).strip()
    return name

def get_best_match(name, candidates):
    """Find best fuzzy match from candidates."""
    norm_name = normalize_name(name)
    best_score = 0
    best_match = None
    
    for cand in candidates:
        norm_cand = normalize_name(cand)
        # SequenceMatcher ratio
        score = SequenceMatcher(None, norm_name, norm_cand).ratio()
        
        # Boost score if one is substring of another
        if len(norm_name) > 10 and (norm_name in norm_cand or norm_cand in norm_name):
             score = max(score, 0.9) 
            
        if score > best_score:
            best_score = score
            best_match = cand
            
    return best_match, best_score

def get_project_type(type_str):
    """Normalize project type."""
    if not type_str: return "Unknown"
    t = str(type_str).lower()
    if "prime" in t: return "Prime"
    if "plus" in t: return "Plus"
    if "mature" in t: return "Mature"
    if "non-mature" in t: return "Non-Mature"
    if "standard" in t: return "Standard"
    return "Unknown"

def main():
    print("Processing BTO data and calculating MOP...")
    
    # 1. Load Scraped Data
    if not RAW_BTO_FILE.exists():
        print(f"Error: {RAW_BTO_FILE} not found.")
        return
        
    with open(RAW_BTO_FILE, 'r', encoding='utf-8') as f:
        raw_data = json.load(f)
        
    # Process Scraped Data into a Lookup Dictionary
    # Key: Normalized Name, Value: Data Dict
    bto_lookup = {}
    
    for row in raw_data:
        if "_raw" in row and len(row) == 1:
            continue
            
        name_key = next((k for k in row.keys() if "BTO" in k and "name" in k), None)
        if not name_key: continue
        
        project_name = row[name_key]
        if not project_name: continue
        
        launch_date_str = row.get("Launch\u00a0date", "")
        est_comp_str = row.get("Estimated\ncompletion\ndate (note)", "")
        brochure_link = row.get("Brochure Link", "")
        units = row.get("Units", "")
        proj_type = row.get("Type", "")

        comp_date = parse_date(est_comp_str)
        if not comp_date:
            est_str = str(est_comp_str).lower()
            if "month" in est_str:
                numbers = re.findall(r'(\d+)', est_str)
                if numbers:
                    months = max(int(n) for n in numbers)
                    launch_date = parse_date(launch_date_str)
                    if launch_date:
                        comp_date = launch_date + timedelta(days=int(months * 30.44))

        if comp_date:
            norm_name = normalize_name(project_name)
            bto_lookup[norm_name] = {
                "name": project_name,
                "completion_date": comp_date,
                "brochure_link": brochure_link,
                "units": units,
                "type": get_project_type(proj_type)
            }
            
    print(f"Prepared lookup for {len(bto_lookup)} scraped projects.")

    # 2. Load GeoJSON (Source of Truth)
    if not GEOJSON_FILE.exists():
        print(f"Error: {GEOJSON_FILE} not found.")
        return
        
    with open(GEOJSON_FILE, 'r', encoding='utf-8') as f:
        geojson = json.load(f)
        
    features = geojson.get("features", [])
    print(f"Processing {len(features)} GeoJSON features.")
    
    # 3. Enrich Features
    output_features = []
    enriched_count = 0
    scraped_names = list(bto_lookup.keys()) # Normalized names for matching
    
    for feature in features:
        props = feature["properties"]
        geo_name = props.get("NAME", "")
        
        # Initialize Base Props
        new_props = props.copy()
        
        # 1. Try Match
        match_norm_name, score = get_best_match(geo_name, scraped_names)
        
        mop_date = None
        est_completion = None
        
        if match_norm_name and score > 0.85:
            # HIT
            bto_data = bto_lookup[match_norm_name]
            
            new_props["PROJECT_NAME"] = bto_data["name"] # Use scraped name (usually cleaner?) or maybe GeoJSON name?
            new_props["BTO_NAME_SCRAPED"] = bto_data["name"]
            
            # Enrich Fields
            new_props["TOTAL_UNITS"] = bto_data["units"]
            new_props["PROJECT_TYPE"] = bto_data["type"]
            new_props["BROCHURE_LINK"] = bto_data["brochure_link"]
            
            # Dates
            est_completion = bto_data["completion_date"]
            enriched_count += 1
            
        else:
            # MISS - Fallback
            new_props["PROJECT_NAME"] = geo_name
            new_props["BTO_NAME_SCRAPED"] = None
            new_props["TOTAL_UNITS"] = None
            new_props["PROJECT_TYPE"] = "Unknown"
            new_props["BROCHURE_LINK"] = None
            
            # Try parse GeoJSON date: "ESTMT_CNSTRN_CMPLTN" -> "4Q 2018"
            geo_date_str = props.get("ESTMT_CNSTRN_CMPLTN", "")
            est_completion = parse_date(geo_date_str)

        # Calculate MOP
        # Initialize defaults to avoid undefined issues in JSON
        new_props["EST_COMPLETION"] = None
        new_props["MOP_EXPIRY_DATE"] = None
        new_props["MOP_EXPIRY_Q"] = "Unknown"

        if est_completion:
            mop_date = est_completion + timedelta(days=365*5)
            new_props["EST_COMPLETION"] = est_completion.strftime("%Y-%m-%d")
            new_props["MOP_EXPIRY_DATE"] = mop_date.strftime("%Y-%m-%d")
             # Format Quarter for display
            q = (mop_date.month - 1) // 3 + 1
            new_props["MOP_EXPIRY_Q"] = f"Q{q} {mop_date.year}"

        # Construct Feature
        new_feature = {
            "type": "Feature",
            "geometry": feature["geometry"],
            "properties": new_props
        }
        output_features.append(new_feature)

    print(f"Enriched {enriched_count} / {len(features)} features with scraped data.")
    
    # 4. Save Output
    output_geojson = {
        "type": "FeatureCollection",
        "features": output_features
    }
    
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_geojson, f, separators=(',', ':'))
        
    print(f"Saved {len(output_features)} features to {OUTPUT_FILE}")

if __name__ == "__main__":
    main()
