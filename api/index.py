# Thin re-export for Vercel compatibility (not used on Render).
# All logic lives in app.py — import from there to avoid duplication.
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import app  # noqa: F401
