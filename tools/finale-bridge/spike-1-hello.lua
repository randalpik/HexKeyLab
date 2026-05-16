-- Spike S1: verify RGP Lua loads and can execute scripts under Wine + Finale 25.
-- Success: an alert dialog shows the Lua version and a confirmation.

local lua_version = _VERSION or "unknown"
local rgp_version = finenv.RawFinaleVersion or "(finenv.RawFinaleVersion not available)"
local mod_path = package.path or "(no package.path)"

local msg = "RGP Lua is alive.\n\n"
         .. "Lua: " .. tostring(lua_version) .. "\n"
         .. "Finale internal version: " .. tostring(rgp_version) .. "\n\n"
         .. "package.path:\n" .. tostring(mod_path)

finenv.UI():AlertInfo(msg, "HKL spike S1")
