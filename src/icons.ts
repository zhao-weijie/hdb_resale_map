import {
    createIcons, X, CircleAlert, ChartNoAxesColumn, Building2, ChevronDown,
    Calendar, MapPin, Search, MousePointer2, Loader, ListFilter, Info, ChevronLeft,
} from 'lucide';

// Keep existing dynamically rendered data-lucide markup, with only used icons bundled.
const icons = {
    X, AlertCircle: CircleAlert, BarChart2: ChartNoAxesColumn, Building2,
    ChevronDown, Calendar, MapPin, Search, MousePointer2, Loader,
    Filter: ListFilter, Info, ChevronLeft,
};

export function refreshIcons(): void { createIcons({ icons }); }

Object.assign(window, { lucide: { createIcons: refreshIcons } });
