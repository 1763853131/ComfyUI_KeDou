# Copyright (c) 2026 UVA Computer Vision Lab
"""Official OmniShotCut transition and relation label mappings."""
intra_int2string = {
    0: "General", 1: "Dissolve", 2: "Wipes", 3: "Push", 4: "Slide",
    5: "Zoom", 6: "Fade", 7: "Doorway", 8: "Padding",
}
inter_int2string = {
    0: "New_Start", 1: "Hard_Cut", 2: "Transition_Source", 3: "Transition",
    4: "Sudden_Jump", 5: "Padding",
}
GENERAL_INTRA_ID = 0
NEW_START_INTER_ID = 0
