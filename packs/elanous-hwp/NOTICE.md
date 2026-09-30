# Third-party license review

License sources checked: the linked PyPI JSON metadata and the repository LICENSE endpoint below (live queries in this build environment). The pack does **not copy or bundle any third-party code**. HWPX is implemented with the Python standard library; only the optional user-installed `hwp5txt` executable is used for legacy HWP. License findings apply to the observed upstream metadata, not to an unverified future release.

| Candidate | PyPI metadata | Repository LICENSE | Apache-2.0 bundling decision |
|---|---|---|---|
| python-hwpx | [python-hwpx JSON](https://pypi.org/pypi/python-hwpx/json): `license_expression: Apache-2.0` | [airmang/python-hwpx LICENSE](https://api.github.com/repos/airmang/python-hwpx/license): Apache License 2.0 | Compatible; not bundled |
| md2hwpx | [md2hwpx JSON](https://pypi.org/pypi/md2hwpx/json): `license: MIT` / MIT classifier | [jundamin/md2hwpx LICENSE](https://api.github.com/repos/jundamin/md2hwpx/license): MIT License | Compatible with notices; not bundled |
| hwpforge | [hwpforge JSON](https://pypi.org/pypi/hwpforge/json): `license_expression: MIT OR Apache-2.0` | [ai-screams/HwpForge LICENSE](https://api.github.com/repos/ai-screams/HwpForge/license): Apache License 2.0 | Compatible under Apache option; not bundled |
| hwpxskill | [hwpxskill JSON](https://pypi.org/pypi/hwpxskill/json): HTTP 404 (no PyPI metadata found) | [canine89/hwpxskill LICENSE](https://api.github.com/repos/canine89/hwpxskill/license): HTTP 404 | Unverified; **do not bundle** |
| pyhwp | [pyhwp JSON](https://pypi.org/pypi/pyhwp/json): AGPLv3+ license and classifier | [mete0r/pyhwp LICENSE](https://api.github.com/repos/mete0r/pyhwp/license): GNU AGPL v3 text | **Do not bundle**; optional executable installed in user's environment only |

To reproduce the lookup, request each linked URL directly and inspect the returned license metadata or LICENSE text. Before redistributing an external library, also pin its version and review that release's source/license and any transitive dependencies. None is redistributed here.
