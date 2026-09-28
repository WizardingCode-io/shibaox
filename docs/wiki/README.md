# Wiki source

These pages are the source of the GitHub wiki at https://github.com/WizardingCode-io/shibaox/wiki. Edit them here, in the repository, and publish them to the wiki:

```sh
git clone https://github.com/WizardingCode-io/shibaox.wiki.git /tmp/shibaox-wiki
rsync -a --delete --exclude .git docs/wiki/ /tmp/shibaox-wiki/
git -C /tmp/shibaox-wiki add -A && git -C /tmp/shibaox-wiki commit -m "docs: sync from docs/wiki" && git -C /tmp/shibaox-wiki push
```

Links between pages are wiki links (`[Gates](Gates)`); they resolve on the wiki, not in this folder.
