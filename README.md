# Telem

## Embedded Commands

```
pio run -e teensy_blink -t upload
pio run -e teensy_serial -t upload
```

## Notes
1. Did have to install teensy rules
2. did have to change the upload protocol to teensy-cli in order to do it remotely (jetson nx teensy-gui won't work)

### To support arduino:

```
curl -fsSL https://raw.githubusercontent.com/platformio/platformio-core/develop/platformio/assets/system/99-platformio-udev.rules | sudo tee /etc/udev/rules.d/99-platformio-udev.rules
sudo service udev restart
```