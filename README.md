# DynamicWeb CLI

## Get started
To install after cloning, move to project dir and run
> $ npm install -g .

## Commands
All commands and options can be viewed by running
> $ dw --help
> 
> $ dw \<command\> --help

### Users and environments
As most commands are pulling or pushing data from the DW admin API, the necessary authorization is required.

To generate an Api-key that the CLI will use, login to your environment
> $ dw login

This will start an interactive session asking for username and password, as well as the name of the environment, so it's possible to switch between different environments easily.
It will also ask for a host, if you're running a local environment, set this to the host it starts up with, i.e `localhost:6001`.

Each environment has its own users, and each user has its own Api-key assigned to it, swap between environments by using
> $ dw env \<env\>

and swap between users by simply supplying the name of the user in the login command
> $ dw login \<username\>

You can view the current environment and user being used by simply typing
> $ dw

The configuration will automatically be created when setting up your first environment, but if you already have an Api-key you want to use for a user, you can modify the config directly in the file located in `usr/.dwc`. The structure should look like the following
```json
{
    "env": {
        "dev": {
            "host": "localhost:6001",
            "users": {
                "DemoUser": {
                    "apiKey": "<keyPrefix>.<key>"
                }
            },
            "current": {
                "user": "DemoUser"
            }
        }
    },
    "current": {
        "env": "dev"
    }
}
```

### Files
> $ dw files \<dirPath\> \<outPath\>

The files command is used to list out and export the structure in your Dynamicweb files archive, as such is has multiple options;
- `-l` `--list`         This will list the directory given in \<dirPath\>
- `-f` `--includeFiles` The list will now also show all files in the directories
- `-r` `--recursive`    By default it only handles the \<dirPath\>, but with this option it will handle all directories under this recursively
- `-e` `--export`       It will export \<dirPath\> into \<outPath\> on your local machine, unzipped by default
- `--raw`             This will keep the content zipped
- `--iamstupid`       This will include the export of the /files/system/log and /files/.cache folders

#### Examples
Exporting all templates from current environment to local solution
> $ cd DynamicWebSolution/Files
> 
> $ dw files /templates ./templates

Listing the system files structure of the current environment
> $ dw files system -lr

### Swift
> $ dw swift \<outPath\>

The swift command is used to easily get your local environment up to date with the latest swift release. It will override all existing directories and content in those, which can then be adjusted in your source control afterwards. It has multiple options to specify which tag or branch to pull;
- `-t` `--tag <tag>`  The tag/branch/release to pull
- `-l` `--list`         Will list all the release versions
- `-n` `--nightly`      Will pull #HEAD, as default is latest release
- `--force`           Used if \<outPath\> is not an empty folder, to override all the content

#### Examples
Getting all the available releases
> $ dw swift -l

Pulling and overriding local solution with latest nightly build
> $ cd DynamicWebSolution/Swift
> 
> $ dw swift . -n --force

### Query
> $ dw query \<query\>

The query command will fire any query towards the admin Api with the given query parameters. This means any query parameter that's necessary for the given query, is required as an option in this command. It's also possible to list which parameters is necessary for the given query through the options;
- `-l` `--list`         Will list all the properties for the given \<query\>
- `-i` `--interactive`  Will perform the \<query\> but without any parameters, as they will be asked for one by one in interactive mode
- `--<queryParam>`  Any parameter the query needs will be sent by '--key value'

#### Examples
Getting all properties for a query
> $ dw query FileByName -l

Getting file information on a specific file by name
> $ dw query FileByName --name DefaultMail.html --directorypath /Templates/Forms/Mail

### Command
> $ dw command \<command\>

Using command will, like query, fire any given command in the solution. It works like query, given the query parameters necessary, however if a `DataModel` is required for the command, it is given in a json-format, either through a path to a .json file or a literal json-string in the command.
- `-l` `--list` Lists all the properties for the command, as well as the json model required **currently not working**
- `--json` Takes a path to a .json file or a literal json, i.e --json '{ abc: "123" }'

#### Examples
Creating a copy of a page using a json-string
> $ dw command PageCopy --json '{ "model": { "SourcePageId": 1189, "DestinationParentPageId": 1129 } }'

Removing a page using a json file
> $ dw command PageMove --json ./PageMove.json

Where PageMove.json contains
```json
{ "model": { "SourcePageId": 1383, "DestinationParentPageId": 1376 } }
```

Deleting a page
> $ dw command PageDelete --json '{ "id": "1383" }'

### Install
> $ dw install \<filePath\>

Install is somewhat of a shorthand for a few commands. It will upload and install a given .dll or .nupkg addin to your current environment.

It's meant to be used to easily apply custom dlls to a given project, it being local or otherwise, so after having a dotnet library built locally, this command can be run, pointing to the built .dll and it will handle the rest with all the addin installation, and it will be available in the DynamicWeb solution as soon as the command finishes.

#### Examples
> $ dw install ./bin/Release/net6.0/CustomProject.dll

### Database
> $ dw database \<outPath\>

This command is used for various actions towards your current environments database.
- `-e` `--export`       Exports your current environments database to a .bacpac file at \<outPath\>

#### Examples
> $ dw database -e ./backup

### Config
> $ dw config

Config is used to manage the .dwc file through the CLI, given any prop it will create the key/value with the path to it.
- `--<property>`  The path and name of the property to set

#### Examples
Changing the host for the dev environment
> $ dw config --env.dev.host localhost:6001
