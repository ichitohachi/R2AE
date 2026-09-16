"""Windows-specific Lua branches with mocked OS/IO; no process is launched."""
from pathlib import Path
import unittest
from lupa import LuaRuntime

SOURCE=(Path(__file__).resolve().parents[1]/'r2ae.lua').read_text()

class WindowsTests(unittest.TestCase):
    def run_windows(self, exit_code=0, running=True, receiver_exists=True):
        lua=LuaRuntime(unpack_returned_tuples=True)
        g=lua.globals();g.EXIT_CODE=exit_code;g.RUNNING=running;g.RECEIVER_EXISTS=receiver_exists
        lua.execute(r'''
        package.config = "\\\n;\n?\n!\n-\n"
        commands, logs, queries = {}, {}, {}
        print = function(...) local a={...};for i,v in ipairs(a) do a[i]=tostring(v) end;logs[#logs+1]=table.concat(a," ") end
        os.getenv = function(key)
            if key=="USERPROFILE" then return "C:/Users/Editor Name" end
        end
        os.execute = function(cmd) commands[#commands+1]=cmd;return EXIT_CODE end
        io.open = function(path)
            if path:match("r2ae_receive.jsx$") and not RECEIVER_EXISTS then return nil end
            return {close=function() return true end}
        end
        io.popen = function(cmd)
            queries[#queries+1]=cmd
            return {read=function() return RUNNING and "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe\r\n" or "" end,
                    close=function() return true end}
        end
        ''')
        prefix=SOURCE[:SOURCE.index('-- ---- Resolve情報取得')]
        launch=SOURCE[SOURCE.index('-- ---- AE起動'):]
        lua.execute(prefix+'\nensure_dir(BRIDGE_DIR)\n'+launch)
        return [g.commands[i] for i in range(1,len(g.commands)+1)],'\n'.join(g.logs[i] for i in range(1,len(g.logs)+1))

    def test_spaces_in_install_paths_are_quoted(self):
        cmds,logs=self.run_windows()
        self.assertEqual(cmds[-1],r'cmd.exe /d /c ""C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe" -r "C:\Users\Editor Name\Documents\ae_bridge\r2ae_receive.jsx""')
        self.assertIn('送信しました',logs)
        self.assertIn(r'"C:\Users\Editor Name\Documents\ae_bridge"',cmds[0])

    def test_nonzero_lua51_exit_is_failure(self):
        _,logs=self.run_windows(exit_code=1)
        self.assertIn('実行に失敗',logs)
        self.assertNotIn('送信しました',logs)

    def test_lua_modern_boolean_exit(self):
        _,logs=self.run_windows(exit_code=True)
        self.assertIn('送信しました',logs)

    def test_ae_not_running_does_not_launch(self):
        cmds,logs=self.run_windows(running=False)
        self.assertEqual(len(cmds),1)
        self.assertIn('起動中のAfter Effectsが見つかりません',logs)

    def test_missing_receiver_does_not_launch(self):
        cmds,logs=self.run_windows(receiver_exists=False)
        self.assertEqual(len(cmds),1)
        self.assertIn('受信JSXが見つかりません',logs)

if __name__=='__main__':unittest.main()
