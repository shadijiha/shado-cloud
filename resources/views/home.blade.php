@extends('layouts.index')

@section('content')
    {{-- Display folders --}}
    @if($files instanceof \App\Http\Controllers\DirectoryStruct)
        @foreach($files->children as $child)
            <div class="folder"
                 onclick="window.location.href = '{{url("/") . "?path=" . str_replace("\\", "\\\\", $child->path)}}';">

                <img src="images/folder.png" alt="{{$child->getRelativePath()}}" title="{{$child->getRelativePath()}}"/>
                <br/>
                <span>{{$child->name}}</span>
            </div>
        @endforeach

        {{-- Display files --}}
        @foreach($files->files as $file)
            <div class="file"
                 onclick="window.location.href = '{{url("/") . "?path=" . str_replace("\\", "\\\\", $file->path)}}';">
                @if(File::exists('images/icons/{{$file->extension}}.png'))
                    <img src="images/icons/{{$file->extension}}.png" class="file_thumnail"
                         alt="{{$file->getRelativePath()}}" title="{{$file->getRelativePath()}}"/>
                @else
                    <img src="images/icons/file.png" class="file_thumnail"/>
                @endif
                <br/>
                <span>{{$file->name}}</span>
            </div>
        @endforeach
    @endif

@endsection
