#!/bin/sh
# Run on the target machine, only as the update stage of the rail template.
# A failed update must never change the trigger registry.
els update-all "$@" || exit $?
eln loop trigger register --update
