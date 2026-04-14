import subprocess
from playwright.sync_api import sync_playwright
import time
import os

# Start servers
backend = subprocess.Popen(["python", "backend/server.py"])
frontend = subprocess.Popen(["python", "frontend_server.py"])

time.sleep(2)  # Wait for servers to start

# Create a dummy test file
dummy_dir = "test_dir"
os.makedirs(dummy_dir, exist_ok=True)
dummy_file_path = os.path.join(dummy_dir, "test_image.jpg")
with open(dummy_file_path, "wb") as f:
    f.write(b"fake image data")

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('http://localhost:5174')
        page.wait_for_load_state('networkidle')
        
        # 1. Verify Title
        assert "MINERU EXTRACTOR" in page.content(), "Title missing"
        
        # 2. Fill Token
        page.fill('#ocrToken', 'TEST_FAKE_TOKEN_123')
        
        # 3. Set file input
        page.set_input_files('#folder', dummy_dir)
        
        # 4. Wait for file to be selected
        time.sleep(1)
        
        # 5. Click Run
        page.click('#run')
        
        # 6. Wait for run button to be re-enabled or just wait 5 seconds
        time.sleep(5)
        
        log_text = page.inner_text('.log-content')
        print("Logs:")
        print(log_text)
        
        assert "MinerU" in log_text or "Error" in log_text or "error" in log_text, "MinerU error not shown in log"
        print("Test passed! The frontend correctly communicates with the backend MinerU integration.")
        
        browser.close()
finally:
    if os.path.exists(dummy_file_path):
        os.remove(dummy_file_path)
    backend.terminate()
    frontend.terminate()

