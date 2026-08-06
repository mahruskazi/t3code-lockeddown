# Running T3 Code in the Background

On a Linux host, T3 Code can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest T3 Code release:

```sh
t3 service install
```

Check whether it is installed:

```sh
t3 service status
```

Update or repair it:

```sh
t3 service update
```

Stop it and remove it from startup:

```sh
t3 service uninstall
```

Updating restarts T3 Code briefly. Let active agent work and terminal commands finish first.

The systemd unit runs the T3 Code entry point that installed it. Nothing is downloaded, so
`service install` and `service update` work without internet access; to move to a new version,
install it yourself and re-run `t3 service update`.

The background service currently requires Linux with systemd.
