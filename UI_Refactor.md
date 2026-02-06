UI/UX Refactor Requirements
1. Design System & Global Styles

Color Palette: Use a light grey background (#F9FAFB) for the main container and pure white (#FFFFFF) for card-based sections.

Border Radius: Apply a consistent 12px border-radius to all containers, inputs, and buttons.

Spacing: Implement a base unit of 8px. Use 24px padding for sections and 12px gap for internal element spacing.

Typography: Use a sans-serif stack (e.g., Inter). Set section headers to 14px/semibold and input labels to 12px/medium with a muted color (e.g., Slate-500).

2. Iconography Integration (Lucide or Heroicons)

Location Header: Prefix with a MapPin icon.

Search Input: Place a Search icon inside the left side of the input field.

Global Filters: Prefix with a Filter icon.

Info Tooltips: Use a Info icon with a light grey stroke for the "Price Distribution" section.

3. Component Refactoring

Input Groups: Combine the Address Search and Radius into a single row. The Radius input should include the unit "m" as an absolute-positioned suffix inside the field.

Selection Mode: Replace the two stacked buttons ("Circle", "Box") with a horizontal Segmented Control (Toggle Group).

Action Buttons: * Set "Select Area on Map" as the Primary Action (Solid brand color, high contrast).

Set "Clear" as a Secondary Action (Ghost/Outline style or subtle text link).

Filters: Group "Time Period," "Flat Type," and "Lease" into a distinct card. Use custom-styled checkboxes or a multi-select chip UI instead of native browser checkboxes.

Tabs: Refactor "Overview" and "Fair Value" into modern tabs with a clear active state (e.g., a high-contrast bottom border or a "pill" background).

4. Layout & Hierarchy

Vertical Rhythm: Ensure clear visual separation between "Location & Selection" and "Global Filters" using a horizontal divider or white-space.

Interactive States: Add subtle hover effects for buttons (brightness-95) and focus rings for inputs (ring-2 in a brand color).

Density: Increase the line-height and padding within inputs to avoid the "cramped" engineer-UI aesthetic.

5. Implementation Goal

Transition the layout from a single-column stack of raw HTML elements to a structured, card-based interface that prioritizes the "Select Area on Map" call-to-action while tucking secondary configuration (filters) into a cohesive group.