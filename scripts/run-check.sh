#!/bin/bash
export $(grep -v '^#' /var/www/kivest/proxy/.env | xargs)
/usr/bin/node /var/www/kivest/scripts/check-models.js
