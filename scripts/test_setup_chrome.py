#!/usr/bin/env python3
"""Exercise the installer with isolated distro files, binaries and package managers."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('setup-chrome.sh')


class SetupChromeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'commands'
        self.release = self.root / 'os-release'
        self.release.write_text('ID=arch\n')
        self.chrome = self.root / 'chrome'
        self.chrome.write_text('#!/bin/sh\necho "Google Chrome test"\n')
        self.chrome.chmod(0o755)
        self.script = self.root / 'setup-chrome.sh'
        self.script.write_text(SCRIPT.read_text().replace(
            '/etc/os-release', str(self.release)
        ).replace('/opt/google/chrome/chrome', str(self.chrome)))
        self.mock('uname', 'if [ "$1" = -s ]; then echo Linux; else echo x86_64; fi')
        self.mock('id', 'echo 0')
        self.mock('stat', 'echo 0')
        self.mock('pacman', 'if [ "$1" = -Qqo ]; then echo google-chrome; fi')
        self.mock('apt-get', 'exit 99')
        self.mock('curl', 'exit 98')

    def mock(self, name, body):
        path = self.bin / name
        path.write_text('#!/bin/sh\nprintf "%s\\n" "' + name + ' $*" >> "$COMMAND_LOG"\n' + body + '\n')
        path.chmod(0o755)

    def run_script(self, *args):
        return subprocess.run(
            ['bash', str(self.script), *args], capture_output=True, text=True,
            env=dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'],
                     COMMAND_LOG=str(self.log)),
        )

    def test_arch_accepts_installed_package_without_downloading(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Google Chrome test', result.stdout)
        self.assertNotIn('apt-get', self.log.read_text())
        self.assertNotIn('curl', self.log.read_text())

    def test_arch_missing_package_fails_without_installing(self):
        self.mock('pacman', 'exit 1')
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertNotIn('apt-get', self.log.read_text())

    def test_arch_rejects_unmanaged_executable(self):
        self.mock('pacman', 'if [ "$1" = -Qqo ]; then echo another-package; fi')
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('owned by the google-chrome', result.stderr)

    def test_arch_rejects_nonroot_executable(self):
        self.mock('stat', 'echo 1000')
        self.assertNotEqual(self.run_script().returncode, 0)

    def test_arch_rejects_redirected_executable(self):
        self.chrome.rename(self.root / 'other-chrome')
        self.chrome.symlink_to(self.root / 'other-chrome')
        self.assertNotEqual(self.run_script().returncode, 0)

    def test_arch_propagates_browser_failure(self):
        self.chrome.write_text('#!/bin/sh\nexit 42\n')
        self.assertEqual(self.run_script().returncode, 42)

    def test_arch_update_requires_reviewed_build(self):
        result = self.run_script('--update')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('reviewed google-chrome package rebuild', result.stderr)
        self.assertNotIn('pacman', self.log.read_text())

    def test_debian_existing_install_unchanged(self):
        self.release.write_text('ID=debian\n')
        self.mock('dpkg-query', 'echo "install ok installed"')
        self.assertEqual(self.run_script().returncode, 0)
        self.assertNotIn('apt-get', self.log.read_text())

    def test_debian_update_uses_apt(self):
        self.release.write_text('ID=debian\n')
        self.mock('dpkg-query', 'echo "install ok installed"')
        self.mock('apt-get', 'exit 0')
        self.assertEqual(self.run_script('--update').returncode, 0)
        self.assertIn('apt-get install -y --only-upgrade google-chrome-stable', self.log.read_text())


if __name__ == '__main__':
    unittest.main()
