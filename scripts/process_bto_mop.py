
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
                # Last day of month... simplifying to 1st of next month - 1 day or just use 28th
                # Let's use end of month logic roughly
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
        # BUT only if they are reasonably long to avoid "West" matching "West Rock"
        if len(norm_name) > 10 and (norm_name in norm_cand or norm_cand in norm_name):
             score = max(score, 0.9) 
            
        if score > best_score:
            best_score = score
            best_match = cand
            
    return best_match, best_score

def main():
    print("Processing BTO data and calculating MOP...")
    
    # 1. Load Scraped Data
    if not RAW_BTO_FILE.exists():
        print(f"Error: {RAW_BTO_FILE} not found.")
        return
        
    with open(RAW_BTO_FILE, 'r', encoding='utf-8') as f:
        raw_data = json.load(f)
        
    print(f"Loaded {len(raw_data)} scraped records.")
    
    # Clean and Process Scraped Data
    bto_projects = []
    
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
            mop_date = comp_date + timedelta(days=365*5) # 5 Years MOP
            
            bto_projects.append({
                "name": project_name,
                "completion_date": comp_date,
                "mop_date": mop_date,
                "brochure_link": brochure_link,
                "town": row.get("Town name", "")
            })

    print(f"Parsed {len(bto_projects)} projects with valid dates.")
    
    # 2. Load GeoJSON
    if not GEOJSON_FILE.exists():
        print(f"Error: {GEOJSON_FILE} not found.")
        return
        
    with open(GEOJSON_FILE, 'r', encoding='utf-8') as f:
        geojson = json.load(f)
        
    features = geojson.get("features", [])
    print(f"Loaded {len(features)} GeoJSON features.")
    
    # 3. Match and Merge
    matched_count = 0
    feature_names = [f["properties"].get("NAME", "") for f in features]
    
    output_features = []
    unmatched_projects = []
    
    for project in bto_projects:
        match_name, score = get_best_match(project["name"], feature_names)
        
        # Stricter threshold
        if match_name and score > 0.85:
            # print(f"Matched: '{project['name']}' <-> '{match_name}' (Score: {score:.2f})")
            
            # Find the feature
            feature = next(f for f in features if f["properties"].get("NAME") == match_name)
            
            # Create new feature with enriched props
            new_props = feature["properties"].copy()
            new_props["PROJECT_NAME"] = project["name"]
            new_props["MOP_EXPIRY_DATE"] = project["mop_date"].strftime("%Y-%m-%d")
            
            # Format Quarter for display
            q = (project["mop_date"].month - 1) // 3 + 1
            new_props["MOP_EXPIRY_Q"] = f"Q{q} {project['mop_date'].year}"
            
            new_props["EST_COMPLETION"] = project["completion_date"].strftime("%Y-%m-%d")
            new_props["BROCHURE_LINK"] = project["brochure_link"]
            new_props["TOWN"] = project["town"]
            
            new_feature = {
                "type": "Feature",
                "geometry": feature["geometry"],
                "properties": new_props
            }
            output_features.append(new_feature)
            matched_count += 1
        else:
            unmatched_projects.append(project["name"])
    
    print(f"Matched {matched_count} projects to GeoJSON polygons.")
    print(f"Unmatched {len(unmatched_projects)} projects.")
    if unmatched_projects:
        print(f"Sample unmatched: {unmatched_projects[:5]}")
    
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
