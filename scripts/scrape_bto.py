
from playwright.sync_api import sync_playwright
import json
import os
from pathlib import Path

OUTPUT_FILE = Path("scripts/data/bto_scrape_raw.json")

def scrape():
    print("Starting scrape...")
    with sync_playwright() as p:
        print("Launching browser...")
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        url = "https://www.housingmap.sg/bto/#brochures"
        print(f"Navigating to {url}...")
        page.goto(url)
        
        # Wait for the table to appear
        print("Waiting for table...")
        try:
            page.wait_for_selector("table", timeout=30000)
        except Exception as e:
            print(f"Error waiting for table: {e}")
            # Capture content to debug
            with open("debug_page.html", "w", encoding="utf-8") as f:
                f.write(page.content())
            browser.close()
            return

        # Extract headers
        headers = [th.inner_text().strip() for th in page.query_selector_all("table th")]
        print(f"Found headers: {headers}")
        
        # Extract rows
        rows_data = []
        rows = page.query_selector_all("table tr")
        print(f"Found {len(rows)} rows (including header)")
        
        for tr in rows:
            cells = tr.query_selector_all("td")
            if not cells:
                continue
                
            row_data = {}
            for i, td in enumerate(cells):
                if i < len(headers):
                    header = headers[i]
                    text = td.inner_text().strip()
                    row_data[header] = text
                    
                    # specific check for brochure link
                    if "Brochure" in header:
                        link = td.query_selector("a")
                        if link:
                            row_data["Brochure Link"] = link.get_attribute("href")

            rows_data.append(row_data)
                
        print(f"Extracted {len(rows_data)} data rows")
        
        browser.close()
        
        # Save to file
        OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(rows_data, f, indent=2)
            
        print(f"Saved data to {OUTPUT_FILE}")

if __name__ == "__main__":
    scrape()
