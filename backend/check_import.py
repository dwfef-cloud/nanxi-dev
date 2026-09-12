# -*- coding: utf-8 -*-
import sys
sys.path.insert(0, r"D:\nanxi-dev\backend")
import os
os.environ["DB_PATH"] = r"D:\.data\lead_system.db"
os.environ["MEDIA_CRAWLER_AUTOSTART"] = "false"
import app.main  # noqa
print("IMPORT OK")
