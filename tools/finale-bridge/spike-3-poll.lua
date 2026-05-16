-- Spike S3: modeless dialog + LuaSocket polling under Wine.
-- Success: dialog opens, stays open, and updates when you send it text from
-- a Linux terminal via:  echo "hello" | nc 127.0.0.1 12345
--
-- Close the dialog to stop the polling loop. The script does not block
-- Finale — you should be able to use Finale while the dialog is open.

local PORT = 12345

local ok_socket, socket = pcall(require, "socket")
if not ok_socket then
  finenv.UI():AlertError(
    "require('socket') failed:\n" .. tostring(socket) ..
    "\n\nLuaSocket is not bundled. Check RGP Lua docs for an alternate networking module.",
    "HKL spike S3")
  return
end

local server, bind_err = socket.bind("127.0.0.1", PORT)
if not server then
  finenv.UI():AlertError(
    "bind on 127.0.0.1:" .. PORT .. " failed:\n" .. tostring(bind_err),
    "HKL spike S3")
  return
end
server:settimeout(0)

local dlg = finale.FCCustomLuaWindow()
dlg:SetTitle(finale.FCString("HKL bridge spike"))

local label = dlg:CreateStatic(0, 0)
label:SetWidth(360)
label:SetText(finale.FCString("waiting on tcp 127.0.0.1:" .. PORT .. " …"))

local recv_count = 0

dlg:RegisterHandleTimer(function(timer_id)
  local client = server:accept()
  if client then
    client:settimeout(0)
    local line = client:receive("*l")
    if line then
      recv_count = recv_count + 1
      label:SetText(finale.FCString(
        "[" .. recv_count .. "] got: " .. line))
    end
    client:close()
  end
end)

dlg:SetTimer(1, 200)  -- 200ms poll
dlg:RegisterCloseWindow(function()
  server:close()
end)

if dlg.ExecuteModeless then
  dlg:ExecuteModeless(nil)
else
  -- fallback for older RGP Lua versions
  dlg:ShowModeless()
end
