-- Glass overlay launcher
-- Double-click to start the Electron overlay in the background.
-- Logs go to /tmp/glass-overlay.log

set overlayDir to "/Users/emilykelt/Library/Mobile Documents/com~apple~CloudDocs/Coding/glass-claude/overlay"

try
	do shell script "cd " & quoted form of overlayDir & " && ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . >> /tmp/glass-overlay.log 2>&1 &"
on error errMsg number errNum
	display dialog "Failed to launch Glass overlay:" & return & errMsg buttons {"OK"} default button "OK" with icon stop
end try
