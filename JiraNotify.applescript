-- A tiny applet whose only job is to own the notification, so that clicking it
-- reaches code we control. `osascript` alone cannot do this: its notifications
-- belong to Script Editor, and clicking those does nothing.
--
-- Applets do not receive command-line arguments, so the watcher hands work over
-- through a payload file, one value per line:
--
--   mode=post  -> the watcher just wrote a new event; show it, then flip to open
--   mode=open  -> we were launched by a notification click; open the URL
--
-- Line 6 is optional and only the expired-token notification sets it: a script
-- to open in Terminal alongside the URL, so replacing a token is one click and
-- a paste instead of finding a path and typing it. Only set-token.sh is ever
-- run — the payload file is writable by anything running as this user, and a
-- click should not become a way to launch whatever was left in it.
--
-- Do not name a variable `lines`: AppleScript reads it as `every line` and the
-- assignment fails with -10006.
--
-- Ceiling: only the most recent URL is kept. Clicking an older notification
-- opens the newest issue. One URL per notification would need a notification
-- identifier that AppleScript does not expose.

-- Not /tmp: macOS clears it on reboot, and a notification that outlives the
-- reboot would then have no URL to open.
on payloadPath()
	return (POSIX path of (path to home folder)) & ".jira-notify-payload"
end payloadPath

on readPayload()
	set payloadFile to my payloadPath()
	try
		return paragraphs of (do shell script "cat " & quoted form of payloadFile)
	on error
		return {}
	end try
end readPayload

on openStashedURL()
	set payloadLines to readPayload()
	-- Leave a trace either way: a click that reaches us but fails to open the
	-- browser looks identical to a click that never arrived.
	do shell script "date '+%H:%M:%S' >> /tmp/jira-notify-click.log"
	if (count of payloadLines) < 5 then
		do shell script "echo '  no payload' >> /tmp/jira-notify-click.log"
		return
	end if
	set theURL to item 5 of payloadLines
	do shell script "echo '  opening " & theURL & "' >> /tmp/jira-notify-click.log"
	if theURL is not "" then open location theURL

	-- `open -a Terminal` and not `tell application "Terminal"`: the second one
	-- needs an Automation permission the user has to grant in a dialog first,
	-- and this has to work the very first time it is needed.
	if (count of payloadLines) < 6 then return
	set theScript to item 6 of payloadLines
	if theScript ends with "/set-token.sh" then
		do shell script "open -a Terminal " & quoted form of theScript
	end if
end openStashedURL

on run
	set payloadLines to readPayload()
	if (count of payloadLines) < 5 then return

	set theMode to item 1 of payloadLines
	set theTitle to item 2 of payloadLines
	set theSubtitle to item 3 of payloadLines
	set theMessage to item 4 of payloadLines

	if theMode is "open" then
		openStashedURL()
		return
	end if

	-- Flip to "open" before posting: if the click arrives while we are still
	-- running, the next launch must not re-post the same notification.
	set payloadFile to my payloadPath()
	do shell script "sed -i '' '1s/.*/open/' " & quoted form of payloadFile
	display notification theMessage with title theTitle subtitle theSubtitle
end run

on reopen
	-- Fires when the app was still running and the click activates it.
	openStashedURL()
end reopen
