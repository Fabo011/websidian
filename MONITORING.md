# Server Monitoring (Beszel)

```
curl -sL https://get.beszel.dev -o /tmp/install-agent.sh
chmod +x /tmp/install-agent.sh
sudo /tmp/install-agent.sh -p 45877 -k "YOUR_PUBLIC_KEY"
```

Then in the UI add the system on port 45877.

> Due to the proxmox host **beszel agent** need to run directly on host, not in a container.

> The **beszel agent** need to be installed separately on every node. Run the three commands above on every node.