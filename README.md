# Telem

## Embedded Commands

```
pio run -e teensy_blink -t upload
pio run -e teensy_serial -t upload
```

## Notes
1. Did have to install teensy rules
2. did have to change the upload protocol to teensy-cli in order to do it remotely (jetson nx teensy-gui won't work)