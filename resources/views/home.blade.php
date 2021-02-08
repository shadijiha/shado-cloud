@extends('layouts.index')

@section('scripts')
    <script>
        let selected = null;

        /************ Folder/File context menu **********/
        function showFolderSettings(e) {
            const menu = document.getElementById("folder_context_menu");
            menu.style.display = "block";
            menu.style.top = mouse.y - 40 + "px";
            menu.style.left = mouse.x - 100 + "px";

            selected = e.getAttribute("data-path");
        }

        function hideFolderSettings() {
            document.getElementById("folder_context_menu").style.display = "none";
        }

        // ************  Download *****************
        function downloadFile() {
            window.open(Routes.api + "/download?path=" + selected);
        }

        // ************  Unzip *****************
        async function unzipFile() {
            const response = await fetch(Routes.index + "/unzip", {
                method: "POST",
                headers: {
                    'Content-Type': "application/json",
                    "X-CSRF-Token": "{{ csrf_token() }}"
                },
                body: JSON.stringify({
                    path: selected
                })
            });
            const json = await response.json();

            checkForErrors(json, RELOAD_PAGE);
        }

        // ************ Share link *************
        function getShareLinkWindow() {
            const key = '{{ \App\Http\Controllers\APITokenController::getValideKey() }}'
            new Window("Share with the world", null, (self) => {
                return `<input type="text" value="${Routes.api}?path=${selected}&key=${key}">`;
            });
        }

        // ************  Delete *****************
        function deleteFileConfirmation() {
            new Window("Delete a file", [
                {
                    value: "Yes",
                    onclick: (win) => {
                        deleteFile();
                        win.close();
                    }
                },
                {
                    value: "No",
                    onclick: (win) => {
                        win.close();
                    }
                }
            ], function () {
                return "Are you sure you want to delete " + selected + "?";
            });
        }

        async function deleteFile() {

            const response = await fetch(`${Routes.index}/api/delete?path=${selected}`);
            const json = await response.json();

            // Show result
            checkForErrors(json, RELOAD_PAGE);
        }

        // *********** Rename *******************
        function showRenameWindow() {
            new Window("Rename", [
                Window.CANCEL_BUTTON,
                {
                    value: "OK",
                    onclick: (self) => {

                        let input = document.getElementById("input_" + self.id).value;

                        // If the name is a path, then return error
                        for (const char of ["\\", "/", "?", ":", ";", ",", "#", "^", "\"", "<", ">", "*", "|"]) {
                            if (input.includes(char)) {
                                new Window("Error", null, function () {
                                    return "The filename cannot contain an invalid character '<b>" + char + "</b>'";
                                });
                                return;
                            }
                        }

                        // If the filename doesn't contain an extension, Then
                        // Use the existing extension
                        let extension = null;
                        if (!input.includes(".")) {
                            let temp = selected.split(/\\+|\/+/g);
                            temp = temp[temp.length - 1].split(".");
                            extension = temp[temp.length - 1];
                        }

                        renameFile(input, extension);
                        self.close();
                    }
                }
            ], function (self) {

                // Computer file name from fullpath
                let tokens = selected.split(/\\+|\/+/g);

                return `
                    <p>Rename ${selected}</p>
                    <input id="input_${self.id}" placeholder="${tokens[tokens.length - 1]}" />
                `;
            });
        }

        async function renameFile(newName, extension) {
            const suffix = extension == null ? "" : "." + extension;
            const response = await fetch(`${Routes.index}/api/rename?path=${selected}&newname=${newName}${suffix}`);
            const json = await response.json();

            checkForErrors(json, RELOAD_PAGE);
        }

        /************** Properties **************/
        async function showProperties() {
            const reponse = await fetch('{{url("/api/info?")}}' + "path=" + selected);
            const json = await reponse.json();

            new Window("Properties", null, function () {

                let str = "<table>";
                for (const prop in json.props) {
                    str += `<tr>
                               <td><b>${prop}</b></td>
                               <td>${json.props[prop]}</td>
                        </tr>`;
                }

                return str + "</table>";
            });
        }

        // **************************************
        window.addEventListener("click", hideFolderSettings);
    </script>

    <!-- To Nagivate -->
    <script>
        function gotoPath(path) {
            const api_key = '{{$key}}';
            @auth
                window.location.href = `${Routes.index}?path=${path}`;
            @else
                window.location.href = `${Routes.api}?path=${path}&key=${api_key}`;
            @endauth
        }
    </script>
@endsection

@section('content')
    {{-- Display folders --}}
    @if($files instanceof \App\Http\structs\DirectoryStruct)
        @foreach($files->children as $child)
            <div class="folder"
                 onclick="gotoPath('{{ str_replace("\\", "\\\\", $child->path) }}')"
                 oncontextmenu="event.preventDefault(); showFolderSettings(this);"
                 data-path="{{ str_replace("\\", "\\\\", $child->path) }}">
                <img src="images/folder.png" alt="{{$child->getRelativePath()}}" title="{{$child->getRelativePath()}}"/>
                <br/>
                <span>{{$child->name}}</span>
            </div>
        @endforeach

        {{-- Display files --}}
        @foreach($files->files as $file)
            <div class="file"
                 onclick="gotoPath('{{ str_replace("\\", "\\\\", $file->path) }}')"
                 oncontextmenu="event.preventDefault(); showFolderSettings(this);"
                 data-path="{{$file->path}}">

                @if(File::exists("images/icons/$file->extension.png"))
                    <img src="images/icons/{{$file->extension}}.png" class="file_thumnail"
                         alt="{{$file->getRelativePath()}}" title="{{$file->getRelativePath()}}"/>
                @elseif ($file->isImage())
                    <img src="{{url("/api")}}?path={{$file->getNative()->getRealPath()}}" class="image_thumnail"
                         alt="{{$file->getRelativePath()}}" title="{{$file->getRelativePath()}}"/>
                @elseif($file->isVideo())
                    <video src="{{url("/api")}}?path={{$file->getNative()->getRealPath()}}" class="video_thumnail"
                    ></video>
                @else
                    <img src="images/icons/file.png" class="file_thumnail"/>
                @endif

                <br/>
                <span>{{$file->name}}</span>
            </div>
        @endforeach
    @endif

    <div id="folder_context_menu">
        <ul>
            <li onclick="downloadFile();">Download</li>
            <li onclick="unzipFile();">Unzip</li>
            <hr/>
            <li onclick="getShareLinkWindow()">Get link</li>
            <hr/>
            <li onclick="showRenameWindow();">Rename</li>
            <li onclick="deleteFileConfirmation();">Delete</li>
            <li onclick="showProperties();">Properties</li>
        </ul>
    </div>

@endsection
