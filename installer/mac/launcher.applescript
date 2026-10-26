-- Akashvani Workflow launcher for macOS.
--
-- scripts/build-mac-app.mjs compiles this into the .app with `osacompile -s`, which makes a
-- normal Mac app that stays open. That gives the editor what a Windows exe does not need:
-- a Dock icon, Quit (Cmd+Q), and a way back to the page. Clicking the app again, while it
-- is running, opens the browser to it.
--
-- The server itself is the pkg binary inside the bundle (Contents/Resources/server/Akashvani).
-- It opens the browser on its own when it starts, so this script only has to start it,
-- reopen the page on request, and stop it on Quit.

property appURL : "http://localhost:3001"

on serverPath()
	return (POSIX path of (path to me)) & "Contents/Resources/server/Akashvani"
end serverPath

on serverIsUp()
	try
		do shell script "/usr/bin/curl -sf -m 1 " & appURL & "/api/health >/dev/null"
		return true
	on error
		return false
	end try
end serverIsUp

-- The server is built for Apple silicon only. hw.optional.arm64 is 1 on those Macs even
-- when this script is running under Rosetta.
on isAppleSilicon()
	try
		return (do shell script "/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null") is "1"
	on error
		return false
	end try
end isAppleSilicon

on startServer()
	if not isAppleSilicon() then
		display dialog "This version of Akashvani Workflow needs a Mac with Apple silicon (M1 or newer)." buttons {"OK"} default button "OK" with icon stop
		quit
		return
	end if
	do shell script quoted form of serverPath() & " >/dev/null 2>&1 &"
end startServer

on run
	if serverIsUp() then
		open location appURL
	else
		startServer()
	end if
end run

-- Clicking the app in the Dock or Finder while it is already running.
on reopen
	if serverIsUp() then
		open location appURL
	else
		startServer()
	end if
end reopen

-- Keeps the app alive; there is nothing to do on each tick.
on idle
	return 60
end idle

-- Stops the server and anything it started (ffmpeg). The bracket in the pattern stops
-- pkill from matching its own command line. The server can restart itself with a new
-- process id after the first-run storage choice, so it is matched by path, not by id.
on quit
	try
		do shell script "/usr/bin/pkill -f 'Contents/Resources/serve[r]/'"
	end try
	continue quit
end quit
